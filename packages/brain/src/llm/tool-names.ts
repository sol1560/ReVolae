/**
 * 工具名在模型接口上的编码。我们的工具名带点（shell.run、cloud.preview），
 * Claude / OpenAI 都只收 ^[a-zA-Z0-9_-]{1,128}$。发出去前换成合法名字，收回来再换回原名。
 * 编码按一次请求里出现的全部名字建表：非法字符换成下划线，撞名时加序号，保证可逆。
 */
export interface ToolNameCodec {
  enc(name: string): string;
  dec(wire: string): string;
}

const VALID = /^[a-zA-Z0-9_-]{1,128}$/;

export function toolNameCodec(names: Iterable<string>): ToolNameCodec {
  const toWire = new Map<string, string>();
  const fromWire = new Map<string, string>();
  const add = (name: string) => {
    if (toWire.has(name)) return;
    let wire = VALID.test(name) ? name : name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120) || "tool";
    for (let i = 2; fromWire.has(wire) && fromWire.get(wire) !== name; i++) wire = `${wire.replace(/_\d+$/, "")}_${i}`;
    toWire.set(name, wire);
    fromWire.set(wire, name);
  };
  // 合法的名字先占位，避免被非法名字换出来的结果抢走
  const all = [...names];
  for (const n of all) if (VALID.test(n)) add(n);
  for (const n of all) add(n);
  return {
    enc: (name) => {
      add(name);
      return toWire.get(name)!;
    },
    dec: (wire) => fromWire.get(wire) ?? wire,
  };
}
