import React, { useEffect, useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { authenticate, notify } from "../../src/platform";
import { TermView } from "../../src/term-view";
import type { TermViewHandle } from "../../src/term-html";
import type { TerminalHandle } from "@cuaremote/client";
import { useSession } from "../../src/session";
import { base, Button, Empty } from "../../src/ui";
import { C } from "../../src/theme";
export default function Terminal() {
  const s = useSession(),
    [open, setOpen] = useState(false),
    handle = useRef<TerminalHandle | undefined>(undefined),
    web = useRef<TermViewHandle>(null);
  useEffect(() => () => handle.current?.close(), []);
  const start = async () => {
    if (!(await authenticate("打开云终端"))) return;
    setOpen(true);
  };
  const msg = async (raw: string) => {
    const m = JSON.parse(raw);
    if (m.type === "ready") {
      try {
        const h = await s.openTerminal(m.cols, m.rows);
        handle.current = h;
        const dec = new TextDecoder();
        h.onData((b) => web.current?.write(dec.decode(b, { stream: true })));
        h.onExit(() => notify("终端已结束"));
      } catch (e) {
        notify("无法打开", String(e));
        setOpen(false);
      }
    } else if (m.type === "data") handle.current?.write(m.data);
    else if (m.type === "resize") handle.current?.resize(m.cols, m.rows);
  };
  if (!open)
    return (
      <View style={[base.screen, { justifyContent: "center", padding: 24 }]}>
        <Empty icon="terminal-outline" title="你的云终端" detail="端到端加密连接。打开前需要验证面容 ID。" />
        <Button title="验证并打开" icon="scan-outline" onPress={() => void start()} />
      </View>
    );
  const keys: [[string, string], ...Array<[string, string]>] = [
    ["Esc", "\u001b"],
    ["Tab", "\t"],
    ["Ctrl-C", "\u0003"],
    ["↑", "\u001b[A"],
    ["↓", "\u001b[B"],
    ["←", "\u001b[D"],
    ["→", "\u001b[C"],
    ["|", "|"],
    ["~", "~"],
    ["/", "/"],
  ];
  return (
    <View style={base.screen}>
      <TermView ref={web} onMessage={(raw) => void msg(raw)} />
      <View style={st.keys}>
        {keys.map(([a, b]) => (
          <Pressable key={a} style={st.key} onPress={() => handle.current?.write(b)}>
            <Text style={st.keyText}>{a}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
const st = StyleSheet.create({
  keys: { flexDirection: "row", gap: 7, padding: 10, backgroundColor: C.panel },
  key: { paddingHorizontal: 9, paddingVertical: 9, borderRadius: 8, backgroundColor: C.raised },
  keyText: { color: C.text, fontSize: 12 },
});
