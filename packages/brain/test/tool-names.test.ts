import { describe, expect, test } from "bun:test";
import { OpenAIWireProvider } from "../src/llm/openai-wire.js";
import { AnthropicWireProvider } from "../src/llm/anthropic-wire.js";
import { toolNameCodec } from "../src/llm/tool-names.js";

describe("工具名编码", () => {
  test("带点的名字换成合法名字，可逆；合法名字原样；撞名加序号", () => {
    const c = toolNameCodec(["shell.run", "shell_run", "propose_plan", "cloud.preview"]);
    expect(c.enc("propose_plan")).toBe("propose_plan");
    expect(c.enc("shell_run")).toBe("shell_run");
    expect(c.enc("shell.run")).toBe("shell_run_2");
    expect(c.enc("cloud.preview")).toBe("cloud_preview");
    for (const n of ["shell.run", "shell_run", "propose_plan", "cloud.preview"]) expect(c.dec(c.enc(n))).toBe(n);
    expect(c.dec("unknown_tool")).toBe("unknown_tool");
  });

  const info = { id: "t", tier: "standard" as const, zdr: false, vision: false, priceIn: 0, priceOut: 0 };
  const req = {
    messages: [
      { role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
      { role: "assistant" as const, content: "", toolCalls: [{ id: "c1", name: "fs.list", args: { path: "/" } }] },
      { role: "tool" as const, toolCallId: "c1", content: [{ type: "text" as const, text: "a" }] },
    ],
    tools: [{ name: "fs.list", description: "d", inputSchema: {} }, { name: "shell.run", description: "d", inputSchema: {} }],
    forceTool: "shell.run",
  };

  test("OpenAI 线格式：请求里全是合法名字，回来的调用还原成原名", async () => {
    let sent: any;
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return Response.json({ choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "x", function: { name: "shell_run", arguments: '{"cmd":"ls"}' } }] } }] });
    }) as typeof fetch;
    try {
      const r = await new OpenAIWireProvider(info, { baseUrl: "http://x", model: "m" }).chat(req as any);
      const names = [...sent.tools.map((t: any) => t.function.name), sent.tool_choice.function.name, sent.messages[1].tool_calls[0].function.name];
      expect(names.every((n: string) => /^[a-zA-Z0-9_-]+$/.test(n))).toBe(true);
      expect(r.toolCalls[0]).toMatchObject({ name: "shell.run", args: { cmd: "ls" } });
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("Anthropic 线格式同样处理", async () => {
    let sent: any;
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return Response.json({ content: [{ type: "tool_use", id: "x", name: "fs_list", input: { path: "/tmp" } }], stop_reason: "tool_use" });
    }) as typeof fetch;
    try {
      const r = await new AnthropicWireProvider(info, { baseUrl: "http://x", model: "m" }).chat(req as any);
      expect(sent.tools.map((t: any) => t.name)).toEqual(["fs_list", "shell_run"]);
      expect(sent.tool_choice.name).toBe("shell_run");
      expect(sent.messages[1].content[0].name).toBe("fs_list");
      expect(r.toolCalls[0]).toMatchObject({ name: "fs.list", args: { path: "/tmp" } });
    } finally {
      globalThis.fetch = orig;
    }
  });
});

import { planSteps } from "../src/agent/loop.js";
describe("计划步骤容错", () => {
  test("数组、JSON 字符串、多行文字、垃圾都能处理", () => {
    expect(planSteps([{ title: "a", channel: "shell" }], "x")).toEqual([{ title: "a", channel: "shell" }]);
    expect(planSteps('[{"title":"b"}]', "x")).toEqual([{ title: "b", channel: undefined }]);
    expect(planSteps("1. 装依赖\n2. 跑测试", "x")).toEqual([{ title: "装依赖" }, { title: "跑测试" }]);
    expect(planSteps(["c"], "x")).toEqual([{ title: "c" }]);
    expect(planSteps(42, "意图")).toEqual([{ title: "意图", channel: "shell" }]);
    expect(planSteps(undefined, "意图")).toEqual([{ title: "意图", channel: "shell" }]);
  });
});
