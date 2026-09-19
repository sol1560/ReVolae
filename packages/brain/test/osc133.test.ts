import { describe, expect, test } from "bun:test";
import { Osc133Parser, stripAnsi } from "../src/terminal/osc133.js";

const enc = new TextEncoder();
const A = "\x1b]133;A\x07";
const B = "\x1b]133;B\x07";
const C = (cmd?: string) => (cmd ? `\x1b]133;C;cmd=${encodeURIComponent(cmd)}\x07` : "\x1b]133;C\x07");
const D = (code?: number) => (code === undefined ? "\x1b]133;D\x07" : `\x1b]133;D;${code}\x07`);
const CWD = (p: string) => `\x1b]7;file://mac.local${encodeURI(p)}\x07`;

function run(chunks: string[], o: ConstructorParameters<typeof Osc133Parser>[1] = {}) {
  let t = 0;
  const p = new Osc133Parser("t1", { now: () => ++t, ...o });
  const events = chunks.flatMap((c) => p.feed(enc.encode(c)));
  return { p, events };
}

describe("OSC 133 分块", () => {
  test("完整一条命令：prompt → running → done，命令来自 cmd=，输出只含 C 到 D 之间", () => {
    const { p, events } = run([`${CWD("/Users/sol/项目")}${A}sol@mac ~ % ${B}ls -la\r\n${C("ls -la")}total 8\r\nfile.txt\r\n${D(0)}${A}sol@mac ~ % `]);
    expect(events.map((e) => e.state)).toEqual(["prompt", "running", "done", "prompt"]);
    const done = events[2]!;
    expect(done).toMatchObject({ blockId: 1, command: "ls -la", cwd: "/Users/sol/项目", exitCode: 0 });
    expect(done.startOffset).toBe(enc.encode(CWD("/Users/sol/项目")).length);
    expect(done.outputOffset).toBeGreaterThan(done.startOffset);
    expect(done.endOffset).toBeGreaterThan(done.outputOffset!);
    const blocks = p.recent();
    expect(blocks).toHaveLength(2); // 完成的 + 新提示符
    expect(Osc133Parser.plain(blocks[0]!).output).toBe("total 8\nfile.txt");
    expect(blocks[0]!.raw).not.toContain("sol@mac"); // 提示符不算输出
    expect(p.byteOffset).toBe(enc.encode(`${CWD("/Users/sol/项目")}${A}sol@mac ~ % ${B}ls -la\r\n${C("ls -la")}total 8\r\nfile.txt\r\n${D(0)}${A}sol@mac ~ % `).length);
  });

  test("序列跨 chunk 到达（ESC 在结尾、参数被切开、ST 终止符）；偏移量按整条流累计", () => {
    const whole = `${A}% ${B}false\r\n\x1b]133;C;cmd=false\x1b\\\x1b]133;D;1\x1b\\`;
    const bytes = enc.encode(whole);
    // 逐字节喂，最苛刻的切法
    let t = 0;
    const p = new Osc133Parser("t1", { now: () => ++t });
    const events = [];
    for (const b of bytes) events.push(...p.feed(new Uint8Array([b])));
    expect(events.map((e) => e.state)).toEqual(["prompt", "running", "done"]);
    expect(events[2]).toMatchObject({ command: "false", exitCode: 1 });
    expect(p.byteOffset).toBe(bytes.length);
    // 对比整段一次喂的偏移，必须一样
    const { events: one } = run([whole]);
    expect(one[2]!.endOffset).toBe(events[2]!.endOffset);
    expect(one[2]!.outputOffset).toBe(events[2]!.outputOffset);
  });

  test("没有 cmd= 时从回显里抠命令（含退格和颜色）；退出码缺省 undefined", () => {
    const { events } = run([`${A}$ ${B}\x1b[32mgit\x1b[0m statsu\b\bus\r\n${C()}On branch main\r\n${D()}`]);
    expect(events[2]).toMatchObject({ command: "git status", state: "done" });
    expect(events[2]!.exitCode).toBeUndefined();
  });

  test("Ctrl-C 没有 D 直接出新提示符：上一块按 done 收尾且没有退出码；没有 A 直接 C 也能开块", () => {
    const { p, events } = run([`${A}$ ${B}sleep 100\r\n${C("sleep 100")}^C\r\n${A}$ `, `${C("echo x")}x\r\n${D(0)}`]);
    const states = events.map((e) => `${e.blockId}:${e.state}`);
    expect(states).toEqual(["1:prompt", "1:running", "1:done", "2:prompt", "2:running", "2:done"]);
    const first = p.recent()[0]!;
    expect(first.exitCode).toBeUndefined();
    expect(Osc133Parser.plain(first).output).toBe("^C");
    expect(p.recent()[1]).toMatchObject({ command: "echo x", exitCode: 0 });
  });

  test("多字节字符跨 chunk 不乱码；输出超限只留尾部并标 truncated；块数超限丢最老的", () => {
    const zh = enc.encode("中文输出");
    const { p } = run([`${A}$ ${B}cat\r\n${C("cat")}`], { maxOutputBytes: 6, maxBlocks: 2 });
    p.feed(zh.subarray(0, 4)); // 切在「文」中间
    p.feed(zh.subarray(4));
    p.feed(enc.encode(D(0)));
    const b = p.recent()[0]!;
    expect(b.truncated).toBe(true);
    expect(b.raw.endsWith("输出")).toBe(true);
    expect(b.raw).not.toContain("\ufffd");
    for (let i = 0; i < 3; i++) p.feed(enc.encode(`${A}$ ${B}n${i}\r\n${C(`n${i}`)}${D(0)}`));
    expect(p.recent().map((x) => x.command)).toEqual(["n1", "n2"]);
  });

  test("plain：去 ANSI、CRLF 归一、超长输出只留尾部", () => {
    const { p } = run([`${A}$ ${B}x\r\n${C("x")}\x1b[1;31mERR\x1b[0m line1\r\n${"y".repeat(5000)}\r\n${D(2)}`]);
    const plain = Osc133Parser.plain(p.recent()[0]!, 100);
    expect(plain.truncated).toBe(true);
    expect(plain.output.startsWith("…")).toBe(true);
    expect(plain.output.endsWith("y".repeat(100))).toBe(true);
    expect(stripAnsi("\x1b[1;31mERR\x1b[0m ok \x1b]0;title\x07")).toBe("ERR ok ");
  });

  test("不认识的 OSC 和普通 ESC 序列不影响分块；不合法 ESC 不吞后面的字节", () => {
    const { p, events } = run([`\x1b]0;窗口标题\x07${A}$ ${B}echo\r\n${C("echo")}a\x1b[Kb\x1b]999;zzz\x07c\r\n${D(0)}`]);
    expect(events.map((e) => e.state)).toEqual(["prompt", "running", "done"]);
    expect(Osc133Parser.plain(p.recent()[0]!).output).toBe("abc");
    const { p: p2 } = run([`${A}$ ${B}q\r\n${C("q")}\x1b]133;D;0\x1bXtail${A}`]); // ESC 后不是 \：序列结束但 X 及后面保留
    expect(p2.recent()[0]!.state).toBe("done");
  });
});
