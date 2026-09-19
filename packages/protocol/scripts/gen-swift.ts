/**
 * 从 zod 定义生成 Swift Codable：packages/protocol/swift/Sources/CuaRemoteProtocol/Protocol.swift
 * 支持的 zod 类型：object / string / number / boolean / enum / literal / union(字面量) / optional / default / nullable / array / record / unknown
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as common from "../src/common.js";
import { AllMessages, PairOffer } from "../src/messages.js";

type Def = any;
const def = (s: any): Def => s._zod.def;

const named = new Map<any, string>();
for (const [name, v] of Object.entries(common)) {
  if (v && typeof v === "object" && "_zod" in (v as object)) named.set(v, name);
}
named.set(PairOffer, "PairOffer");

const emitted = new Map<string, string>();
const order: string[] = [];
function emit(name: string, code: string) {
  if (emitted.has(name)) return;
  emitted.set(name, code);
  order.push(name);
}

const pascal = (s: string) => s.replace(/(^|[_.\-\s])(\w)/g, (_m, _p, c) => c.toUpperCase()).replace(/\W/g, "");
const camel = (s: string) => {
  const p = pascal(s);
  return p.charAt(0).toLowerCase() + p.slice(1);
};
const swiftReserved = new Set(["type", "default", "operator", "protocol", "class", "struct", "enum", "func", "var", "let", "in", "for", "is", "as", "self", "Self", "true", "false", "nil", "import", "return", "case", "switch"]);
const ident = (s: string) => (swiftReserved.has(s) ? `\`${s}\`` : s);

function swiftType(schema: any, hint: string): { type: string; optional: boolean } {
  const d = def(schema);
  switch (d.type) {
    case "optional":
      return { type: swiftType(d.innerType, hint).type, optional: true };
    case "default":
      return { type: swiftType(d.innerType, hint).type, optional: true };
    case "nullable":
      return { type: swiftType(d.innerType, hint).type, optional: true };
    case "string":
      return { type: "String", optional: false };
    case "boolean":
      return { type: "Bool", optional: false };
    case "number": {
      const isInt = d.checks?.some((c: any) => c._zod.def.check === "number_format" && /int/.test(c._zod.def.format));
      return { type: isInt ? "Int" : "Double", optional: false };
    }
    case "unknown":
    case "any":
      return { type: "JSONValue", optional: false };
    case "array":
      return { type: `[${swiftType(d.element, hint + "Item").type}]`, optional: false };
    case "record":
      return { type: `[String: ${swiftType(d.valueType, hint + "Value").type}]`, optional: false };
    case "literal": {
      const v = d.values[0];
      return { type: typeof v === "number" ? "Int" : typeof v === "boolean" ? "Bool" : "String", optional: false };
    }
    case "enum": {
      const name = named.get(schema) ?? hint;
      emit(name, stringEnum(name, Object.values(d.entries) as string[]));
      return { type: name, optional: false };
    }
    case "union": {
      const name = named.get(schema) ?? hint;
      const opts = d.options.map(def);
      if (opts.every((o: Def) => o.type === "literal" && typeof o.values[0] === "number")) {
        emit(name, intEnum(name, opts.map((o: Def) => o.values[0] as number)));
        return { type: name, optional: false };
      }
      if (opts.every((o: Def) => o.type === "literal" && typeof o.values[0] === "string")) {
        emit(name, stringEnum(name, opts.map((o: Def) => o.values[0] as string)));
        return { type: name, optional: false };
      }
      return { type: "JSONValue", optional: false };
    }
    case "object": {
      const name = named.get(schema) ?? hint;
      emit(name, struct(name, schema));
      return { type: name, optional: false };
    }
    default:
      throw new Error(`unsupported zod type ${d.type} at ${hint}`);
  }
}

function stringEnum(name: string, values: string[]) {
  const cases = values.map((v) => `    case ${ident(camel(v))} = "${v}"`).join("\n");
  return `public enum ${name}: String, Codable, Sendable, CaseIterable {\n${cases}\n}\n`;
}
function intEnum(name: string, values: number[]) {
  const cases = values.map((v) => `    case l${v} = ${v}`).join("\n");
  return `public enum ${name}: Int, Codable, Sendable, CaseIterable, Comparable {\n${cases}\n    public static func < (a: ${name}, b: ${name}) -> Bool { a.rawValue < b.rawValue }\n}\n`;
}

function struct(name: string, schema: any): string {
  const shape = def(schema).shape as Record<string, any>;
  const lines: string[] = [];
  const inits: string[] = [];
  const initBody: string[] = [];
  const keys: string[] = [];
  let typeLiteral: string | undefined;
  for (const [key, sub] of Object.entries(shape)) {
    const d = def(sub);
    if (key === "type" && d.type === "literal") {
      typeLiteral = d.values[0];
      lines.push(`    public var type: String = "${typeLiteral}"`);
      keys.push("type");
      continue;
    }
    if (key === "v" && d.type === "literal") {
      lines.push(`    public var v: Int = 1`);
      keys.push("v");
      continue;
    }
    const st = swiftType(sub, name + pascal(key));
    const field = ident(camel(key));
    const t = st.optional ? `${st.type}?` : st.type;
    lines.push(`    public var ${field}: ${t}`);
    inits.push(`${field}: ${t}${st.optional ? " = nil" : ""}`);
    initBody.push(`        self.${field} = ${field}`);
    keys.push(key);
  }
  const codingKeys = keys.map((k) => (camel(k) === k ? `        case ${ident(k)}` : `        case ${ident(camel(k))} = "${k}"`)).join("\n");
  const extra = typeLiteral ? `    public static let messageType = "${typeLiteral}"\n` : "";
  return `public struct ${name}: Codable, Sendable {\n${extra}${lines.join("\n")}\n\n    public init(${inits.join(", ")}) {\n${initBody.join("\n")}\n    }\n\n    enum CodingKeys: String, CodingKey {\n${codingKeys}\n    }\n}\n`;
}

// 先生成 common 里的具名类型（保证名字稳定）
for (const [s, name] of named) {
  const d = def(s);
  if (["object", "enum", "union"].includes(d.type)) swiftType(s, name);
}
// 消息
const messageNames: { swift: string; type: string }[] = [];
for (const [name, s] of Object.entries(AllMessages)) {
  swiftType(s, name);
  messageNames.push({ swift: name, type: def(s).shape.type._zod.def.values[0] });
}

const header = `// 由 packages/protocol/scripts/gen-swift.ts 生成，不要手改。MIT。
import Foundation

/// 任意 JSON 值
public enum JSONValue: Codable, Sendable, Equatable {
    case string(String), number(Double), bool(Bool), null
    case array([JSONValue]), object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let b = try? c.decode(Bool.self) { self = .bool(b); return }
        if let n = try? c.decode(Double.self) { self = .number(n); return }
        if let s = try? c.decode(String.self) { self = .string(s); return }
        if let a = try? c.decode([JSONValue].self) { self = .array(a); return }
        if let o = try? c.decode([String: JSONValue].self) { self = .object(o); return }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "bad JSON value")
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let n): try c.encode(n)
        case .bool(let b): try c.encode(b)
        case .null: try c.encodeNil()
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }
}

public let protocolVersion = 1
`;

const anyMessage = `
/// 所有控制消息的类型安全包装；按 \`type\` 字段解码。
public enum AnyMessage: Codable, Sendable {
${messageNames.map((m) => `    case ${camel(m.swift)}(${m.swift})`).join("\n")}

    private struct Peek: Decodable { let type: String }

    public var typeName: String {
        switch self {
${messageNames.map((m) => `        case .${camel(m.swift)}: return "${m.type}"`).join("\n")}
        }
    }

    public init(from decoder: Decoder) throws {
        let t = try Peek(from: decoder).type
        let c = try decoder.singleValueContainer()
        switch t {
${messageNames.map((m) => `        case "${m.type}": self = .${camel(m.swift)}(try c.decode(${m.swift}.self))`).join("\n")}
        default:
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "unknown message type \\(t)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
${messageNames.map((m) => `        case .${camel(m.swift)}(let v): try c.encode(v)`).join("\n")}
        }
    }
}
`;

const out = header + "\n" + order.map((n) => emitted.get(n)!).join("\n") + anyMessage;
const target = join(import.meta.dir, "..", "swift", "Sources", "CuaRemoteProtocol", "Protocol.swift");
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, out);
console.log(`wrote ${target} (${order.length} types, ${messageNames.length} messages)`);
