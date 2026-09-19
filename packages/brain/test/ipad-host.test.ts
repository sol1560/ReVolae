import { describe, expect, test } from "bun:test";
import { displacement, type CalibrationModel, type Point } from "@cuaremote/ipad-pointer-calibration";
import type { Scope, ToolDescriptor } from "@cuaremote/protocol";
import type { Host, ToolResult } from "../src/host/types.js";
import { IPAD_DEVICE_TOOLS, IPAD_TOOLS, IpadHost, hasIpadTools, wrapIfIpad } from "../src/ipad/ipad-host.js";

const W = 1024;
const H = 768;
/** 假 iPad 的真实加速曲线（非线性、单调），和 firmware/dongle/calibration 的测试一致 */
const REAL: CalibrationModel = {
  width: W,
  height: H,
  maxReport: 80,
  curve: [
    { input: 1, output: 0.7 }, { input: 2, output: 1.5 }, { input: 4, output: 3.4 }, { input: 8, output: 7.8 }, { input: 12, output: 13.5 }, { input: 16, output: 20 },
    { input: 24, output: 34 }, { input: 32, output: 50 }, { input: 48, output: 82 }, { input: 64, output: 118 }, { input: 80, output: 158 },
  ],
};

const dev = (name: string, staticLevel: 0 | 1 = 1): ToolDescriptor => ({ name, description: name, channel: "ipad", staticLevel, costClass: 0, dataLeavesDevice: false, inputSchema: {} });
const SCOPE: Scope = { allowedDirs: [], allowedApps: [], deniedCommands: [] };

type Step = Record<string, unknown>;

/**
 * 假 iPad 设备：按真实曲线移动指针、撞墙夹住、记录点击 / 按键 / 输入；
 * 可选不提供 pointer / clipboard / calibration 工具，模拟功能少的 app。
 */
function fakeIpad(o: { pointer?: Point; without?: string[]; savedModel?: CalibrationModel; screenPointer?: boolean } = {}) {
  const state = {
    pointer: o.pointer ?? { x: 100, y: 100 },
    clicks: [] as { at: Point; count: number }[],
    keys: [] as string[],
    typed: "" as string,
    clipboard: "" as string,
    saved: o.savedModel as CalibrationModel | undefined,
    macros: 0,
    maxMacroSteps: 0,
    scrolls: [] as { dx: number; dy: number }[],
    failMacro: false,
  };
  const all = [dev(IPAD_DEVICE_TOOLS.screen, 0), dev(IPAD_DEVICE_TOOLS.pointer, 0), dev(IPAD_DEVICE_TOOLS.macro), dev(IPAD_DEVICE_TOOLS.clipboard), dev(IPAD_DEVICE_TOOLS.calGet, 0), dev(IPAD_DEVICE_TOOLS.calPut), dev("shortcuts.run")];
  const tools = all.filter((t) => !o.without?.includes(t.name));
  const ok = (output?: string, attachments: ToolResult["attachments"] = []): ToolResult => ({ ok: true, output, attachments, ms: 1 });
  const applyMove = (dx: number, dy: number) => {
    const len = Math.hypot(dx, dy);
    const gain = len ? displacement(len, REAL) / len : 0;
    state.pointer = { x: Math.max(0, Math.min(W - 1, state.pointer.x + dx * gain)), y: Math.max(0, Math.min(H - 1, state.pointer.y + dy * gain)) };
  };
  const host: Host = {
    listTools: async () => ({ tools, scope: SCOPE }),
    call: async (name, args): Promise<ToolResult> => {
      switch (name) {
        case IPAD_DEVICE_TOOLS.screen:
          return ok(JSON.stringify({ width: W, height: H, ...(o.screenPointer ? { pointer: state.pointer } : {}) }), [{ kind: "image/jpeg", inline: "AAAA" }]);
        case IPAD_DEVICE_TOOLS.pointer:
          return ok(JSON.stringify({ x: state.pointer.x, y: state.pointer.y, width: W, height: H }));
        case IPAD_DEVICE_TOOLS.clipboard:
          state.clipboard = String(args.text);
          return ok();
        case IPAD_DEVICE_TOOLS.calGet:
          return state.saved ? ok(JSON.stringify(state.saved)) : { ok: false, error: "没有校准", attachments: [], ms: 1 };
        case IPAD_DEVICE_TOOLS.calPut:
          state.saved = args.model as CalibrationModel;
          return ok();
        case IPAD_DEVICE_TOOLS.macro: {
          if (state.failMacro) return { ok: false, error: "dongle 409 队列满", attachments: [], ms: 1 };
          const steps = args.steps as Step[];
          state.macros++;
          state.maxMacroSteps = Math.max(state.maxMacroSteps, steps.length);
          if (steps.length > 128) throw new Error("宏超过 128 步");
          for (const s of steps) {
            if ("delayMs" in s) continue;
            switch (s.action) {
              case "mouse.move":
                if (Math.abs(Number(s.dx)) > 127 || Math.abs(Number(s.dy)) > 127) throw new Error("单报文超过 127");
                applyMove(Number(s.dx), Number(s.dy));
                break;
              case "mouse.click":
                state.clicks.push({ at: { ...state.pointer }, count: Number(s.count) });
                break;
              case "mouse.scroll":
                state.scrolls.push({ dx: Number(s.dx), dy: Number(s.dy) });
                break;
              case "key.press":
                state.keys.push([...((s.modifiers as string[]) ?? []), s.key].join("+"));
                if (s.key === "v" && (s.modifiers as string[])?.includes("cmd")) state.typed += state.clipboard;
                break;
              case "key.type":
                if (!/^[\x20-\x7e\n\t]*$/.test(String(s.text))) throw new Error("固件收到非 ASCII");
                state.typed += String(s.text);
                break;
              default:
                throw new Error(`未知宏动作 ${String(s.action)}`);
            }
          }
          return ok();
        }
        default:
          return ok(`ran ${name}`);
      }
    },
  };
  return { host, state };
}

describe("IpadHost：工具表", () => {
  test("底层工具被藏起来，模型只看到 ipad.* 绝对坐标工具；非 iPad 工具照常透传", async () => {
    const { host } = fakeIpad();
    const wrapped = await wrapIfIpad(host);
    expect(wrapped).toBeInstanceOf(IpadHost);
    const { tools } = await wrapped.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(["shortcuts.run", ...IPAD_TOOLS.map((t) => t.name)]);
    expect(names.some((n) => n === IPAD_DEVICE_TOOLS.macro)).toBe(false);
    expect((await wrapped.call("shortcuts.run", { name: "x" })).output).toBe("ran shortcuts.run");
  });

  test("没有 pointer 工具就不给 calibrate；不是 iPad 的宿主原样返回", async () => {
    const { host } = fakeIpad({ without: [IPAD_DEVICE_TOOLS.pointer] });
    const { tools } = await new IpadHost(host).listTools();
    expect(tools.some((t) => t.name === "ipad.calibrate")).toBe(false);
    expect(tools.some((t) => t.name === "ipad.tap")).toBe(true);

    const mac: Host = { listTools: async () => ({ tools: [dev("shell.run")], scope: SCOPE }), call: async () => ({ ok: true, attachments: [], ms: 0 }) };
    expect(hasIpadTools([dev("shell.run")])).toBe(false);
    expect(await wrapIfIpad(mac)).toBe(mac);
  });
});

describe("IpadHost：校准 → 点击", () => {
  test("先校准（四方向一圈回原位），再点绝对坐标，误差 < 4px，模型存回设备", async () => {
    const { host, state } = fakeIpad({ pointer: { x: 30, y: 700 } });
    const ipad = new IpadHost(host);
    expect(ipad.calibrated).toBe(false);

    const r = await ipad.call("ipad.calibrate", {});
    expect(r.ok).toBe(true);
    expect(r.output).toContain("44 个样本");
    expect(r.output).toContain("已存到设备");
    expect(ipad.calibrated).toBe(true);
    expect(state.saved?.curve.length).toBeGreaterThanOrEqual(9);
    // 校准期间每个增量是独立报文（README 要求），不能合并
    expect(state.maxMacroSteps).toBe(1);

    const tap = await ipad.call("ipad.tap", { x: 900, y: 120 });
    expect(tap.ok).toBe(true);
    expect(state.clicks).toHaveLength(1);
    expect(state.clicks[0]!.count).toBe(1);
    expect(Math.hypot(state.clicks[0]!.at.x - 900, state.clicks[0]!.at.y - 120)).toBeLessThan(4);

    // 第二次点击从预测位置出发（不归零），双击
    const tap2 = await ipad.call("ipad.tap", { x: 200, y: 600, count: 2 });
    expect(tap2.ok).toBe(true);
    expect(tap2.output).not.toContain("归零");
    expect(Math.hypot(state.clicks[1]!.at.x - 200, state.clicks[1]!.at.y - 600)).toBeLessThan(4);
    expect(state.clicks[1]!.count).toBe(2);
  });

  test("没校准就点：明确报错，不发任何宏", async () => {
    const { host, state } = fakeIpad();
    const r = await new IpadHost(host).call("ipad.tap", { x: 10, y: 10 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("ipad.calibrate");
    expect(state.macros).toBe(0);
  });

  test("设备存过校准模型：第一次点击先从设备取，指针未知时撞左上角归零再走", async () => {
    const { host, state } = fakeIpad({ savedModel: REAL, pointer: { x: 777, y: 333 } });
    const ipad = new IpadHost(host);
    const r = await ipad.call("ipad.tap", { x: 500, y: 400 });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("归零");
    expect(Math.hypot(state.clicks[0]!.at.x - 500, state.clicks[0]!.at.y - 400)).toBeLessThan(4);
    expect(state.macros).toBe(1);
  });

  test("增量超过 128 步时分批发宏（低增益曲线归零要几百个报文）", async () => {
    // 假 iPad 的真实曲线不变，只是大脑拿到的模型被截到 maxReport=4：每报文最多走 3.4px，横穿 1024px 要 300+ 个报文
    const slow: CalibrationModel = { ...REAL, maxReport: 4, curve: REAL.curve.slice(0, 3) };
    const { host, state } = fakeIpad({ savedModel: slow, pointer: { x: 900, y: 700 } });
    const r = await new IpadHost(host).call("ipad.tap", { x: 50, y: 40 });
    expect(r.ok).toBe(true);
    expect(state.macros).toBeGreaterThan(2);
    expect(state.maxMacroSteps).toBeLessThanOrEqual(128);
    expect(Math.hypot(state.clicks[0]!.at.x - 50, state.clicks[0]!.at.y - 40)).toBeLessThan(4);
  });

  test("截图带回真实指针位置时覆盖预测；宏失败后指针标记为不可信", async () => {
    const { host, state } = fakeIpad({ savedModel: REAL, screenPointer: true, pointer: { x: 10, y: 10 } });
    const ipad = new IpadHost(host);
    const shot = await ipad.call("ipad.screenshot", {});
    expect(shot.ok).toBe(true);
    expect(shot.output).toContain("1024×768");
    expect(shot.output).toContain("指针在 (10, 10)");
    expect(shot.attachments[0]!.kind).toBe("image/jpeg");

    const r1 = await ipad.call("ipad.tap", { x: 300, y: 300 });
    expect(r1.output).not.toContain("归零"); // 截图给了指针，不必归零
    state.failMacro = true;
    const bad = await ipad.call("ipad.tap", { x: 400, y: 400 });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("409");
    state.failMacro = false;
    const r3 = await ipad.call("ipad.tap", { x: 400, y: 400 });
    expect(r3.output).toContain("归零");
    expect(Math.hypot(state.clicks.at(-1)!.at.x - 400, state.clicks.at(-1)!.at.y - 400)).toBeLessThan(4);
  });
});

describe("IpadHost：键盘 / 滚动", () => {
  test("ASCII 直接敲；中文走剪贴板 + Cmd+V；没有剪贴板工具时中文明确失败", async () => {
    const { host, state } = fakeIpad();
    const ipad = new IpadHost(host);
    expect((await ipad.call("ipad.type", { text: "Hello, World! 123\n" })).ok).toBe(true);
    expect(state.typed).toBe("Hello, World! 123\n");
    expect(state.keys).toEqual([]);

    expect((await ipad.call("ipad.type", { text: "你好 world" })).ok).toBe(true);
    expect(state.clipboard).toBe("你好 world");
    expect(state.keys).toEqual(["cmd+v"]);
    expect(state.typed).toBe("Hello, World! 123\n你好 world");

    const { host: noClip, state: s2 } = fakeIpad({ without: [IPAD_DEVICE_TOOLS.clipboard] });
    const r = await new IpadHost(noClip).call("ipad.type", { text: "中文" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("剪贴板");
    expect(s2.macros).toBe(0);
  });

  test("长文本按 1024 拆块，一次宏发完", async () => {
    const { host, state } = fakeIpad();
    const text = "a".repeat(2500);
    expect((await new IpadHost(host).call("ipad.type", { text })).ok).toBe(true);
    expect(state.typed).toBe(text);
    expect(state.macros).toBe(1);
  });

  test("按键：合法键 / 修饰键放行，未知键拒绝", async () => {
    const { host, state } = fakeIpad();
    const ipad = new IpadHost(host);
    expect((await ipad.call("ipad.key", { key: "h", modifiers: ["cmd"] })).ok).toBe(true);
    expect((await ipad.call("ipad.key", { key: "Enter" })).ok).toBe(true);
    expect(state.keys).toEqual(["cmd+h", "enter"]);
    expect((await ipad.call("ipad.key", { key: "f13" })).ok).toBe(false);
    expect((await ipad.call("ipad.key", { key: "a", modifiers: ["hyper"] })).ok).toBe(false);
    expect(state.keys).toHaveLength(2);
  });

  test("滚动：dy 正数向下 = HID wheel 负数；带坐标先移过去", async () => {
    const { host, state } = fakeIpad({ savedModel: REAL, pointer: { x: 0, y: 0 } });
    const ipad = new IpadHost(host);
    expect((await ipad.call("ipad.scroll", { dy: 3 })).ok).toBe(true);
    expect(state.scrolls).toEqual([{ dx: 0, dy: -1 }, { dx: 0, dy: -1 }, { dx: 0, dy: -1 }]);
    state.scrolls.length = 0;
    expect((await ipad.call("ipad.scroll", { x: 600, y: 500, dy: -2 })).ok).toBe(true);
    expect(state.scrolls).toEqual([{ dx: 0, dy: 1 }, { dx: 0, dy: 1 }]);
    expect(Math.hypot(state.pointer.x - 600, state.pointer.y - 500)).toBeLessThan(4);
    expect((await ipad.call("ipad.scroll", {})).ok).toBe(false);
  });
});
