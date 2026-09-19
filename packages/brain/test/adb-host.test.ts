import { describe, expect, test } from "bun:test";
import type { Scope, ToolDescriptor } from "@cuaremote/protocol";
import type { Host, ToolResult } from "../src/host/types.js";
import { ADB_RAW_TOOL, ADB_TOOLS, AdbHost, adbTextArg, hasAdbTool, parseDevices, parseNotifications, parseUiAutomatorXml, wrapIfAdb } from "../src/android/adb-host.js";

const SCOPE: Scope = { allowedDirs: [], allowedApps: [], deniedCommands: [] };
const RAW: ToolDescriptor = { name: ADB_RAW_TOOL, description: "", channel: "android", staticLevel: 1, costClass: 0, dataLeavesDevice: true, inputSchema: {} };
const OTHER: ToolDescriptor = { name: "shell.run", description: "", channel: "shell", staticLevel: 1, costClass: 0, dataLeavesDevice: false, inputSchema: {} };

const DEVICES_ONE = "List of devices attached\nemulator-5554          device product:sdk_gphone64 model:Pixel_7 device:emu64a transport_id:1\n\n";
const DEVICES_TWO = "List of devices attached\nemulator-5554 device model:Pixel_7\nR5CT1234ABC offline model:SM_S918B\n192.168.1.20:5555 device model:Pixel_Tablet\n";

const UI_XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" class="android.widget.FrameLayout" package="com.x" content-desc="" clickable="false" bounds="[0,0][1080,2400]">
    <node index="0" text="Search &quot;here&quot; &amp; go" class="android.widget.EditText" clickable="true" focusable="true" bounds="[100,200][980,300]"/>
    <node index="1" text="" class="android.widget.Button" content-desc="Send &#20320;" clickable="true" bounds="[900,2200][1080,2400]">
      <node index="0" text="deep" class="android.widget.TextView" clickable="false" bounds="[901,2201][1000,2300]"/>
    </node>
  </node>
</hierarchy>`;

/** 假宿主：暴露 android.adb，按 cmd 前缀回应并记录所有调用 */
function fakeAdb(o: { devices?: string; ui?: string; fail?: RegExp; withRaw?: boolean } = {}) {
  const calls: { serial?: string; cmd: string; image?: boolean }[] = [];
  const host: Host = {
    async listTools() {
      return { tools: o.withRaw === false ? [OTHER] : [OTHER, RAW], scope: SCOPE };
    },
    async call(tool, args): Promise<ToolResult> {
      if (tool !== ADB_RAW_TOOL) return { ok: true, output: `inner:${tool}`, attachments: [], ms: 1 };
      const cmd = String(args.cmd);
      calls.push({ serial: args.serial as string | undefined, cmd, ...(args.image ? { image: true } : {}) });
      if (o.fail?.test(cmd)) return { ok: false, error: "boom", attachments: [], ms: 1 };
      if (cmd === "devices -l") return { ok: true, output: o.devices ?? DEVICES_ONE, attachments: [], ms: 1 };
      if (cmd.startsWith("exec-out screencap")) return { ok: true, output: "截图 100 字节", attachments: [{ kind: "image/jpeg", inline: "AAAA" }], ms: 1 };
      if (cmd.includes("uiautomator dump")) return { ok: true, output: o.ui ?? UI_XML, attachments: [], ms: 1 };
      if (cmd.includes("pm list packages")) return { ok: true, output: "package:com.b.app\npackage:com.a.app\n", attachments: [], ms: 1 };
      if (cmd.includes("monkey -p com.bad")) return { ok: true, output: "** No activities found to run, monkey aborted.", attachments: [], ms: 1 };
      if (cmd.includes("monkey -p")) return { ok: true, output: "Events injected: 1", attachments: [], ms: 1 };
      if (cmd.includes("dumpsys notification")) return { ok: true, output: DUMPSYS, attachments: [], ms: 1 };
      return { ok: true, output: "", attachments: [], ms: 1 };
    },
  };
  return { host, calls };
}

const DUMPSYS = `NOTIFICATION MANAGER (dumpsys notification)
  NotificationRecord(0xabc: pkg=com.whatsapp user=UserHandle{0} id=1 tag=null key=0|com.whatsapp|1|null|10123: Notification(...))
      extras={
        android.title=String (张三)
        android.text=String (晚上一起吃饭?)
        android.subText=null
      }
  NotificationRecord(0xdef: pkg=com.android.systemui user=UserHandle{0} id=2 tag=null key=...)
      extras={
        android.title=SpannableString (Charging)
      }
`;

describe("解析", () => {
  test("adb devices -l：跳过表头和空行，带型号", () => {
    expect(parseDevices(DEVICES_TWO)).toEqual([
      { serial: "emulator-5554", state: "device", model: "Pixel_7" },
      { serial: "R5CT1234ABC", state: "offline", model: "SM_S918B" },
      { serial: "192.168.1.20:5555", state: "device", model: "Pixel_Tablet" },
    ]);
    expect(parseDevices("List of devices attached\n\n")).toEqual([]);
  });

  test("uiautomator XML：先序编号、自闭合、嵌套、实体转义、bounds 转 l,t,r,b", () => {
    const els = parseUiAutomatorXml(UI_XML, { maxElements: 100, maxDepth: 30 });
    expect(els.map((e) => e.index)).toEqual([0, 1, 2, 3]);
    expect(els[1]).toEqual({ index: 1, className: "android.widget.EditText", text: 'Search "here" & go', bounds: "100,200,980,300", clickable: true, editable: true });
    expect(els[2]?.contentDescription).toBe("Send 你");
    expect(els[2]?.editable).toBe(false);
    expect(els[3]).toMatchObject({ index: 3, text: "deep", bounds: "901,2201,1000,2300", clickable: false });
  });

  test("uiautomator XML：maxDepth 裁掉深层、maxElements 截断", () => {
    const shallow = parseUiAutomatorXml(UI_XML, { maxElements: 100, maxDepth: 1 });
    expect(shallow.map((e) => e.text ?? e.contentDescription)).toEqual([undefined, 'Search "here" & go', "Send 你"]);
    expect(parseUiAutomatorXml(UI_XML, { maxElements: 2, maxDepth: 30 })).toHaveLength(2);
  });

  test("dumpsys notification：按 NotificationRecord 分组，取第一条 title/text", () => {
    expect(parseNotifications(DUMPSYS)).toEqual([
      { packageName: "com.whatsapp", title: "张三", text: "晚上一起吃饭?" },
      { packageName: "com.android.systemui", title: "Charging" },
    ]);
  });

  test("input text 参数：空格变 %s，shell 特殊字符转义", () => {
    expect(adbTextArg("hello world")).toBe('"hello%sworld"');
    expect(adbTextArg(`a"b$c&d`)).toBe('"a\\"b\\$c\\&d"');
  });
});

describe("AdbHost", () => {
  test("工具表：隐藏 android.adb，暴露 android.* 十一个工具；没有 android.adb 时原样透传", async () => {
    const { host } = fakeAdb();
    const wrapped = await wrapIfAdb(host);
    expect(wrapped).toBeInstanceOf(AdbHost);
    const { tools } = await wrapped.listTools();
    expect(hasAdbTool(tools)).toBe(false);
    expect(tools.map((t) => t.name)).toEqual(["shell.run", ...ADB_TOOLS.map((t) => t.name)]);
    expect(ADB_TOOLS).toHaveLength(11);

    const plain = fakeAdb({ withRaw: false });
    expect(await wrapIfAdb(plain.host)).toBe(plain.host);
    const forced = new AdbHost(plain.host);
    expect((await forced.listTools()).tools.map((t) => t.name)).toEqual(["shell.run"]);
    expect((await forced.call("shell.run", {})).output).toBe("inner:shell.run");
  });

  test("单台在线自动选 serial；ui_tree 后按 index 点击元素中心；index 在下一次 ui_tree 前有效", async () => {
    const { host, calls } = fakeAdb();
    const h = new AdbHost(host);
    const tree = await h.call("android.ui_tree", {});
    expect(tree.ok).toBe(true);
    expect(JSON.parse(tree.output!)).toHaveLength(4);
    const tap = await h.call("android.tap", { index: 1 });
    expect(tap.ok).toBe(true);
    expect(calls.at(-1)).toEqual({ serial: "emulator-5554", cmd: "shell input tap 540 250" });

    // 没 ui_tree 过的 index 报错，坐标点击不需要 ui_tree
    expect((await h.call("android.tap", { index: 9 })).error).toContain("index 9 已失效");
    const xy = await h.call("android.long_press", { x: 10, y: 20 });
    expect(xy.ok).toBe(true);
    expect(calls.at(-1)?.cmd).toBe("shell input swipe 10 20 10 20 600");
  });

  test("多台在线又没给 serial 报错；给了 serial 就用它；全离线也报错", async () => {
    const two = new AdbHost(fakeAdb({ devices: DEVICES_TWO }).host);
    const r = await two.call("android.key", { key: "home" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("2 台");
    expect(r.error).toContain("192.168.1.20:5555");

    const fx = fakeAdb({ devices: DEVICES_TWO });
    const ok = await new AdbHost(fx.host).call("android.key", { key: "home", serial: "R5CT1234ABC" });
    expect(ok.ok).toBe(true);
    expect(fx.calls.at(-1)).toEqual({ serial: "R5CT1234ABC", cmd: "shell input keyevent 3" });

    const none = new AdbHost(fakeAdb({ devices: "List of devices attached\nX offline\n" }).host);
    expect((await none.call("android.key", { key: "back" })).error).toContain("没有在线");
  });

  test("按键映射；未知按键报错", async () => {
    const fx = fakeAdb();
    const h = new AdbHost(fx.host);
    for (const [k, code] of [["back", 4], ["recents", 187], ["enter", 66], ["volume_up", 24], ["volume_down", 25]] as const) {
      await h.call("android.key", { key: k });
      expect(fx.calls.at(-1)?.cmd).toBe(`shell input keyevent ${code}`);
    }
    expect((await h.call("android.key", { key: "power" })).ok).toBe(false);
  });

  test("set_text：先点元素再 input text；非 ASCII 拒绝且不发命令", async () => {
    const fx = fakeAdb();
    const h = new AdbHost(fx.host);
    await h.call("android.ui_tree", {});
    const n = fx.calls.length;
    const r = await h.call("android.set_text", { index: 1, text: "hi there" });
    expect(r.ok).toBe(true);
    expect(fx.calls.slice(n).map((c) => c.cmd)).toEqual(["shell input tap 540 250", 'shell input text "hi%sthere"']);

    const zh = await h.call("android.set_text", { index: 1, text: "你好" });
    expect(zh.ok).toBe(false);
    expect(zh.error).toContain("ASCII");
    expect(fx.calls.length).toBe(n + 2);
  });

  test("swipe 需要四个坐标，默认 300ms", async () => {
    const fx = fakeAdb();
    const h = new AdbHost(fx.host);
    expect((await h.call("android.swipe", { fromX: 1, fromY: 2 })).error).toContain("缺少参数 toX");
    await h.call("android.swipe", { fromX: 500, fromY: 1500, toX: 500, toY: 300 });
    expect(fx.calls.at(-1)?.cmd).toBe("shell input swipe 500 1500 500 300 300");
  });

  test("launch：包名校验；monkey 找不到 activity 算失败", async () => {
    const fx = fakeAdb();
    const h = new AdbHost(fx.host);
    expect((await h.call("android.launch", { packageName: "com.x; rm -rf /" })).error).toBe("包名不合法");
    expect((await h.call("android.launch", { packageName: "com.bad" })).ok).toBe(false);
    const ok = await h.call("android.launch", { packageName: "com.good.app" });
    expect(ok.ok).toBe(true);
    expect(fx.calls.at(-1)?.cmd).toBe("shell monkey -p com.good.app -c android.intent.category.LAUNCHER 1");
  });

  test("screenshot 走 image 模式并把附件带回；apps 排序去前缀；notifications 解析；devices 列表", async () => {
    const fx = fakeAdb();
    const h = new AdbHost(fx.host);
    const shot = await h.call("android.screenshot", {});
    expect(shot.ok).toBe(true);
    expect(shot.attachments).toEqual([{ kind: "image/jpeg", inline: "AAAA" }]);
    expect(fx.calls.at(-1)).toEqual({ serial: "emulator-5554", cmd: "exec-out screencap -p", image: true });

    expect(JSON.parse((await h.call("android.apps", {})).output!)).toEqual(["com.a.app", "com.b.app"]);
    expect(JSON.parse((await h.call("android.notifications", {})).output!)[0]).toMatchObject({ packageName: "com.whatsapp", title: "张三" });
    expect(JSON.parse((await h.call("android.devices", {})).output!)).toEqual([{ serial: "emulator-5554", state: "device", model: "Pixel_7" }]);
  });

  test("底层 adb 失败时返回 ok:false 而不是抛错，并且下一步重新查设备", async () => {
    const fx = fakeAdb({ fail: /uiautomator/ });
    const h = new AdbHost(fx.host);
    await h.call("android.key", { key: "back" });
    const r = await h.call("android.ui_tree", {});
    expect(r.ok).toBe(false);
    expect(r.error).toContain("uiautomator dump 失败");
    expect(typeof r.ms).toBe("number");
    expect(fx.calls.filter((c) => c.cmd === "devices -l")).toHaveLength(1);
    await h.call("android.key", { key: "back" });
    expect(fx.calls.filter((c) => c.cmd === "devices -l")).toHaveLength(2);
  });

  test("自动选中的 serial 会缓存：连续多步只查一次设备", async () => {
    const fx = fakeAdb();
    const h = new AdbHost(fx.host);
    await h.call("android.key", { key: "back" });
    await h.call("android.key", { key: "home" });
    await h.call("android.apps", {});
    expect(fx.calls.filter((c) => c.cmd === "devices -l")).toHaveLength(1);
  });
});
