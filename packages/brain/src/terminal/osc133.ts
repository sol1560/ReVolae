/**
 * OSC 133 命令分块（Warp / iTerm2 / kitty 都用这套标记）：把 PTY 字节流切成「一条命令 + 它的输出 + 退出码」的块。
 *
 * shell 集成脚本（shell-integration/）在合适的时机往终端写：
 *   ESC ] 133 ; A BEL        提示符开始
 *   ESC ] 133 ; B BEL        用户开始输入命令
 *   ESC ] 133 ; C ; cmd=<percent-encoded 命令> BEL   命令开始执行（cmd= 是我们自己加的，没有就从回显里抠）
 *   ESC ] 133 ; D ; <exit> BEL   命令结束
 *   ESC ] 7 ; file://host/path BEL  当前目录（标准 OSC 7）
 * 终止符 BEL(0x07) 或 ST(ESC \) 都认。序列跨 chunk 到达也能拼上。
 *
 * 这份 TS 实现给两处用：daemon 侧的参考（Swift 照抄）和 brain 在终端模式取「最近几条命令 + 输出」当上下文。
 * 偏移量 offset 是这个会话 PTY 流的累计字节数，和 terminal.ack 用的是同一把尺子，手机可以据此在自己的缓冲里画块边界。
 */
import type { TerminalBlock } from "@cuaremote/protocol";

export interface Osc133Options {
  /** 每块最多保留多少字节输出（超出丢头留尾） */
  maxOutputBytes?: number;
  /** 最多保留多少块 */
  maxBlocks?: number;
  now?: () => number;
}

export interface BlockRecord extends TerminalBlock {
  /** 原始输出（含 ANSI），已按 maxOutputBytes 截尾 */
  raw: string;
  truncated: boolean;
}

const ESC = 0x1b;
const BEL = 0x07;
const dec = new TextDecoder();

export class Osc133Parser {
  private offset = 0;
  private pending = new Uint8Array(0);
  private blocks: BlockRecord[] = [];
  private current?: BlockRecord;
  private seq = 0;
  private cwd?: string;
  /** B 之后、C 之前的回显（用于没有 cmd= 时抠命令） */
  private typed = "";
  private readonly maxOut: number;
  private readonly maxBlocks: number;
  private readonly now: () => number;
  /** 文本用流式解码（多字节字符可能跨 chunk），OSC 体用普通解码 */
  private readonly textDec = new TextDecoder();

  constructor(readonly sessionId: string, o: Osc133Options = {}) {
    this.maxOut = o.maxOutputBytes ?? 64 * 1024;
    this.maxBlocks = o.maxBlocks ?? 50;
    this.now = o.now ?? Date.now;
  }

  /** 喂一段 PTY 输出，返回这段里发生的块状态变化（给 terminal.block 事件用） */
  feed(chunk: Uint8Array): TerminalBlock[] {
    const events: TerminalBlock[] = [];
    let buf = this.pending.length ? concat(this.pending, chunk) : chunk;
    // pending 里的字节已经计过 offset，这里只对新 chunk 计
    let base = this.offset - this.pending.length;
    this.pending = new Uint8Array(0);
    let i = 0;
    let textStart = 0;
    while (i < buf.length) {
      if (buf[i] !== ESC) {
        i++;
        continue;
      }
      // 结尾孤零零一个 ESC：还不知道后面是不是 ]，留到下一次
      const end = i + 1 >= buf.length ? -1 : buf[i + 1] === 0x5d /* ] */ ? findOscEnd(buf, i + 2) : null;
      if (end === null) {
        i++;
        continue;
      }
      if (end === -1) {
        // 序列没收全：先把之前的文本交出去，剩下的留到下一次
        this.text(buf.subarray(textStart, i));
        this.pending = buf.slice(i);
        this.offset = base + buf.length;
        return events;
      }
      this.text(buf.subarray(textStart, i));
      const body = dec.decode(buf.subarray(i + 2, end.payloadEnd));
      const at = base + i;
      events.push(...this.osc(body, at));
      i = end.next;
      textStart = i;
    }
    this.text(buf.subarray(textStart));
    this.offset = base + buf.length;
    return events;
  }

  /** 最近 n 块（老→新） */
  recent(n = 10): BlockRecord[] {
    const all = this.current ? [...this.blocks, this.current] : this.blocks;
    return all.slice(-n);
  }

  get byteOffset() {
    return this.offset;
  }

  /** 给模型看的纯文本版本：去 ANSI、去回车，输出截尾 */
  static plain(b: BlockRecord, maxChars = 4000): { command?: string; cwd?: string; exitCode?: number; output: string; truncated: boolean } {
    let output = stripAnsi(b.raw).replace(/\r\n?/g, "\n").trim();
    let truncated = b.truncated;
    if (output.length > maxChars) {
      output = `…（前面省略）\n${output.slice(-maxChars)}`;
      truncated = true;
    }
    return { command: b.command, cwd: b.cwd, exitCode: b.exitCode, output, truncated };
  }

  private text(bytes: Uint8Array) {
    if (!bytes.length) return;
    const s = this.textDec.decode(bytes, { stream: true });
    if (this.current?.state === "running") this.append(this.current, s);
    else if (this.current?.state === "prompt" && this.typedMode) this.typed += s;
  }
  private typedMode = false;

  private append(b: BlockRecord, s: string) {
    b.raw += s;
    if (Buffer.byteLength(b.raw) > this.maxOut) {
      b.raw = tailBytes(b.raw, this.maxOut);
      b.truncated = true;
    }
  }

  private osc(body: string, at: number): TerminalBlock[] {
    const semi = body.indexOf(";");
    const code = semi < 0 ? body : body.slice(0, semi);
    const rest = semi < 0 ? "" : body.slice(semi + 1);
    if (code === "7") {
      // file://host/path
      const m = /^file:\/\/[^/]*(\/.*)$/.exec(rest);
      if (m) this.cwd = safeDecode(m[1]!);
      if (this.current && this.current.state !== "done") this.current.cwd = this.cwd;
      return [];
    }
    if (code !== "133") return [];
    const [kind, ...params] = rest.split(";");
    switch (kind) {
      case "A": {
        const out: TerminalBlock[] = [];
        // 新提示符：上一块如果还没 D（比如 Ctrl-C 打断），先收尾
        if (this.current && this.current.state !== "done") out.push(this.finish(this.current, undefined, at));
        const b: BlockRecord = { sessionId: this.sessionId, blockId: ++this.seq, state: "prompt", cwd: this.cwd, startedAt: this.now(), startOffset: at, raw: "", truncated: false };
        this.current = b;
        this.typed = "";
        this.typedMode = false;
        out.push(strip(b));
        return out;
      }
      case "B":
        if (!this.current || this.current.state === "done") {
          // 没有 A 直接 B（有些 shell 集成不发 A）：当作新块
          const b: BlockRecord = { sessionId: this.sessionId, blockId: ++this.seq, state: "prompt", cwd: this.cwd, startedAt: this.now(), startOffset: at, raw: "", truncated: false };
          this.current = b;
        }
        this.typed = "";
        this.typedMode = true;
        return [];
      case "C": {
        if (!this.current || this.current.state === "done") {
          const b: BlockRecord = { sessionId: this.sessionId, blockId: ++this.seq, state: "prompt", cwd: this.cwd, startedAt: this.now(), startOffset: at, raw: "", truncated: false };
          this.current = b;
        }
        const cur = this.current;
        const cmdParam = params.find((p) => p.startsWith("cmd="));
        cur.command = cmdParam ? safeDecode(cmdParam.slice(4)) : cleanTyped(this.typed) || undefined;
        cur.state = "running";
        cur.outputOffset = at;
        this.typedMode = false;
        return [strip(cur)];
      }
      case "D": {
        const cur = this.current;
        if (!cur || cur.state === "done") return [];
        const code = params[0] !== undefined && params[0] !== "" ? Number(params[0]) : undefined;
        return [this.finish(cur, Number.isFinite(code) ? code : undefined, at)];
      }
      default:
        return [];
    }
  }

  private finish(b: BlockRecord, exitCode: number | undefined, at: number): TerminalBlock {
    b.state = "done";
    b.exitCode = exitCode;
    b.finishedAt = this.now();
    b.endOffset = at;
    this.blocks.push(b);
    if (this.blocks.length > this.maxBlocks) this.blocks.splice(0, this.blocks.length - this.maxBlocks);
    this.current = undefined;
    this.typedMode = false;
    return strip(b);
  }
}

/** 找 OSC 结束：BEL 或 ESC \ ；返回 payload 结束位置和下一个字节位置；没找到返回 -1 */
function findOscEnd(buf: Uint8Array, from: number): { payloadEnd: number; next: number } | -1 {
  for (let j = from; j < buf.length; j++) {
    const c = buf[j]!;
    if (c === BEL) return { payloadEnd: j, next: j + 1 };
    if (c === ESC) {
      if (j + 1 >= buf.length) return -1; // 还不知道是不是 ST
      if (buf[j + 1] === 0x5c /* \ */) return { payloadEnd: j, next: j + 2 };
      return { payloadEnd: j, next: j }; // 不合法的 ESC：当作序列到此为止，别吞掉后面的
    }
  }
  return -1;
}

/** 从尾部保留不超过 max 字节（按字符切，不会切坏多字节字符） */
function tailBytes(s: string, max: number): string {
  let bytes = 0;
  let i = s.length;
  while (i > 0) {
    const cp = s.codePointAt(i - 1)!;
    // 低代理项：整个码点占 2 个 UTF-16 单元
    const units = cp >= 0xdc00 && cp <= 0xdfff && i >= 2 ? 2 : 1;
    const ch = s.slice(i - units, i);
    const n = Buffer.byteLength(ch);
    if (bytes + n > max) break;
    bytes += n;
    i -= units;
  }
  return s.slice(i);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function strip(b: BlockRecord): TerminalBlock {
  const { raw: _r, truncated: _t, ...rest } = b;
  return { ...rest };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 从 B→C 之间的回显里抠命令：去 ANSI、去退格造成的字符、取最后一行 */
function cleanTyped(s: string): string {
  const plain = stripAnsi(s).replace(/\r/g, "");
  const line = plain.split("\n").filter((l) => l.trim()).at(-1) ?? "";
  // 处理退格：\b 或 0x7f 删前一个字符
  let out = "";
  for (const ch of line) {
    if (ch === "\b" || ch === "\x7f") out = out.slice(0, -1);
    else out += ch;
  }
  return out.trim();
}

// CSI / OSC / 其它 ESC 序列
const ANSI_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}
