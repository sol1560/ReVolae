import { confirm, notify, pickDocument } from "../../src/platform";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import React, { useState } from "react";
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import type { QuickCard } from "@cuaremote/protocol";
import { useSession } from "../../src/session";
import { C } from "../../src/theme";
import { base, Button, Card } from "../../src/ui";
export default function Home() {
  const s = useSession(),
    router = useRouter(),
    [text, setText] = useState(""),
    [variants, setVariants] = useState(false),
    [card, setCard] = useState<QuickCard>(),
    [vals, setVals] = useState<Record<string, string>>({}),
    [uploading, setUploading] = useState(false);
  const cloud = s.state.cloud;
  const send = async (t = text, v = variants, label?: string) => {
    if (!t.trim()) return;
    try {
      await Haptics.impactAsync();
      await s.submit(t, v ? 3 : undefined, label);
      setText("");
      setTimeout(() => router.push("/(tabs)/tasks"), 250);
    } catch (e) {
      notify("未能提交", String(e));
    }
  };
  const select = (c: QuickCard) => {
    if (!c.fields.length) {
      void send(c.intent, Boolean(c.variants));
      return;
    }
    setCard(c);
    setVals({});
  };
  const pickFile = async (key: string) => {
    const f = await pickDocument();
    if (!f) return;
    setUploading(true);
    try {
      const path = await s.upload(f.name, f.blob);
      setVals((v) => ({ ...v, [key]: path }));
    } catch (e) {
      notify("上传失败", String(e));
    } finally {
      setUploading(false);
    }
  };
  const runCard = () => {
    if (!card) return;
    let intent = card.intent;
    for (const f of card.fields) intent = intent.replaceAll(`{${f.key}}`, vals[f.key] || "");
    setCard(undefined);
    // 列表里显示「卡片名 · 用户填的文字」，文件字段只显示文件名
    const said = card.fields.map((f) => (f.kind === "file" ? (vals[f.key] ?? "").split("/").pop() : vals[f.key])).filter(Boolean).join("，");
    void send(intent, Boolean(card.variants), said ? `${card.title} · ${said}` : card.title);
  };
  return (
    <ScrollView style={base.screen} contentContainerStyle={base.content}>
      <View style={base.between}>
        <View>
          <Text style={base.title}>云电脑</Text>
          <Text style={base.muted}>一句话，把事情交给它</Text>
        </View>
        <View style={st.credit}>
          <Text style={st.creditText}>{s.state.billing?.credits ?? 0} CRD</Text>
        </View>
      </View>
      <Card style={st.machine}>
        <View>
          <Text style={base.heading}>我的 Linux</Text>
          <Text style={base.muted}>
            {s.connection === "online"
              ? { running: "运行中", paused: "已暂停", none: "未创建" }[cloud?.state ?? "none"]
              : s.connection === "connecting"
                ? "正在连接…"
                : "离线"}
          </Text>
        </View>
        <View style={[st.dot, { backgroundColor: cloud?.state === "running" ? C.green : C.amber }]} />
        {cloud?.state !== "running" && <Button title="唤醒" kind="quiet" onPress={() => void s.request({ type: "cloud.wake" }, "cloud.status")} />}
      </Card>
      {!!cloud?.snapshots.length && (
        <Card style={{ gap: 10 }}>
          <View style={base.row}>
            <Ionicons name="time-outline" size={18} color={C.muted} />
            <Text style={base.text}>整台机器可以撤回到这些任务之前</Text>
          </View>
          {cloud.snapshots.slice(0, 3).map((x) => (
            <View key={x.runId} style={base.between}>
              <View style={{ flex: 1, marginRight: 10 }}>
                <Text style={base.text} numberOfLines={1}>
                  {x.title ?? "任务"}
                </Text>
                <Text style={base.muted}>{new Date(x.createdAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} 之前</Text>
              </View>
              <Button
                title="撤回"
                kind="quiet"
                icon="arrow-undo-outline"
                onPress={async () => {
                  if (await confirm("撤回整台云电脑？", `回到「${x.title ?? "这个任务"}」开始之前，之后做的改动都会消失。`, "撤回"))
                    void s.request({ type: "cloud.undo", runId: x.runId }, "cloud.status").catch((e) => notify("撤回失败", String(e)));
                }}
              />
            </View>
          ))}
        </Card>
      )}
      <TextInput
        value={text}
        onChangeText={setText}
        multiline
        placeholder="让云电脑做点什么…"
        placeholderTextColor={C.muted}
        style={[base.input, st.composer]}
      />
      <View style={base.between}>
        <Pressable style={base.row} onPress={() => (cloud?.variantsAllowed === 3 ? setVariants(!variants) : router.push("/(tabs)/me"))}>
          <Switch value={variants} disabled={cloud?.variantsAllowed !== 3} onValueChange={setVariants} trackColor={{ true: C.blue }} />
          <Ionicons name={cloud?.variantsAllowed === 3 ? "copy-outline" : "lock-closed"} color={C.muted} size={16} />
          <Text style={base.text}>试 3 种做法</Text>
        </Pressable>
        <Button title="开始" icon="arrow-up" disabled={!text.trim() || s.connection !== "online"} onPress={() => void send()} />
      </View>
      <Text style={[base.heading, { marginTop: 12 }]}>快速开始</Text>
      <View style={st.grid}>
        {(cloud?.cards ?? []).map((c) => (
          <Pressable key={c.id} style={st.quick} onPress={() => select(c)}>
            <Ionicons name="flash-outline" size={24} color={C.blue} />
            <Text style={st.quickTitle}>{c.title}</Text>
            <Text style={base.muted}>{c.subtitle}</Text>
          </Pressable>
        ))}
      </View>
      {!cloud?.cards.length && <Text style={base.muted}>连接云电脑后，这里会出现为你准备的快捷任务。</Text>}
      <Modal visible={!!card} transparent animationType="slide" onRequestClose={() => setCard(undefined)}>
        <Pressable style={st.backdrop} onPress={() => setCard(undefined)} />
        <View style={st.sheet}>
          <Text style={base.heading}>{card?.title}</Text>
          {card?.fields.map((f) => (
            <View key={f.key} style={{ gap: 7 }}>
              <Text style={base.muted}>{f.label}</Text>
              {f.kind === "choice" ? (
                <View style={base.row}>
                  {f.choices?.map((x) => (
                    <Button key={x} title={x} kind={vals[f.key] === x ? "primary" : "quiet"} onPress={() => setVals({ ...vals, [f.key]: x })} />
                  ))}
                </View>
              ) : f.kind === "file" ? (
                <Button title={uploading ? "上传中…" : (vals[f.key] ?? "选择文件")} kind="quiet" disabled={uploading} onPress={() => void pickFile(f.key)} />
              ) : (
                <TextInput
                  style={base.input}
                  placeholder={f.placeholder}
                  placeholderTextColor={C.muted}
                  onChangeText={(v) => setVals({ ...vals, [f.key]: v })}
                />
              )}
            </View>
          ))}
          <Button title="运行任务" disabled={uploading || !card?.fields.every((f) => vals[f.key]?.trim())} onPress={runCard} />
        </View>
      </Modal>
    </ScrollView>
  );
}
const st = StyleSheet.create({
  credit: { backgroundColor: C.raised, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20 },
  creditText: { color: C.amber, fontWeight: "800" },
  machine: { flexDirection: "row", alignItems: "center", gap: 12 },
  dot: { width: 10, height: 10, borderRadius: 5, marginLeft: "auto" },
  composer: { height: 120, textAlignVertical: "top" },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  quick: { width: "48%", minHeight: 140, backgroundColor: C.panel, borderRadius: 20, padding: 16, gap: 8, borderWidth: 1, borderColor: C.line },
  quickTitle: { color: C.text, fontWeight: "700", fontSize: 16 },
  backdrop: { flex: 1, backgroundColor: "#0009" },
  sheet: { backgroundColor: C.panel, padding: 22, paddingBottom: 40, borderTopLeftRadius: 28, borderTopRightRadius: 28, gap: 16 },
});
