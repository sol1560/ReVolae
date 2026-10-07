import { Ionicons } from "@expo/vector-icons";
import * as WebBrowser from "expo-web-browser";
import { authenticate, confirm, saveAndShare } from "../../src/platform";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useState } from "react";
import { Image, Pressable, ScrollView, Text, View } from "react-native";
import { useSession } from "../../src/session";
import { runTitle } from "../../src/store";
import { base, Button, Card, Empty } from "../../src/ui";
import { C } from "../../src/theme";
export default function Detail() {
  const { id } = useLocalSearchParams<{ id: string }>(),
    s = useSession(),
    router = useRouter(),
    [picked, setPicked] = useState<string>(),
    r = s.state.runs[id];
  if (!r)
    return (
      <View style={base.screen}>
        <Empty icon="alert-circle-outline" title="找不到任务" detail="它可能还没从云电脑同步过来。" />
      </View>
    );
  const approve = async (step: string, allow: boolean) => {
    const a = r.approvals[step];
    if (!a) return;
    if (allow) {
      if (!(await authenticate("确认执行此操作"))) return;
    }
    await s.approve(a, allow);
  };
  const dl = async (x: (typeof r.downloads)[number]) => {
    await saveAndShare(x.url, x.name);
  };
  const undo = async () => {
    if (await confirm("撤销整台机器？", "任务之后对云电脑做的更改也会消失。", "确认撤销")) void s.request({ type: "cloud.undo", runId: r.runId }, "cloud.status");
  };
  const hasSnapshot = s.state.cloud?.snapshots.some((x) => x.runId === r.runId);
  const kids = Object.values(s.state.runs)
    .filter((k) => k.parentRunId === r.runId)
    .sort((a, b) => a.runId.localeCompare(b.runId));
  const pick = async (forkId?: string) => {
    await s.request({ type: "cloud.pick", runId: r.runId, ...(forkId ? { forkId } : {}) }, "cloud.status");
    setPicked(forkId ?? "none");
  };
  return (
    <ScrollView style={base.screen} contentContainerStyle={base.content}>
      <Text style={[base.title, { fontSize: 24, lineHeight: 30 }]} numberOfLines={4}>
        {runTitle(s.state, r.parentRunId ? (s.state.runs[r.parentRunId] ?? r) : r)}
      </Text>
      {r.approach && <Text style={{ color: C.blue }}>方案 · {r.approach}</Text>}
      <Text style={base.muted}>{r.summary ?? (kids.length ? `复制成 ${kids.length} 台云电脑，同时各做一版` : "云电脑正在处理…")}</Text>
      {!r.variants &&
        kids.map((k) => {
          const done = k.plan.filter((x) => x.status === "done").length;
          const now = k.plan.find((x) => x.status === "running" || x.status === "awaiting_approval");
          return (
            <Pressable key={k.runId} onPress={() => router.push(`/task/${encodeURIComponent(k.runId)}`)}>
              <Card style={{ gap: 8 }}>
                <View style={base.between}>
                  <Text style={[base.heading, { flex: 1 }]} numberOfLines={1}>
                    {k.approach?.split("：")[0] ?? "做法"}
                  </Text>
                  <Text style={{ color: k.summary ? C.green : C.amber }}>{k.summary ? "完成" : `${done} / ${k.plan.length || "…"}`}</Text>
                </View>
                <View style={{ height: 6, borderRadius: 3, backgroundColor: C.raised, overflow: "hidden" }}>
                  <View style={{ width: `${k.summary ? 100 : k.plan.length ? (done / k.plan.length) * 100 : 5}%`, height: 6, backgroundColor: k.summary ? C.green : C.blue }} />
                </View>
                <Text style={base.muted} numberOfLines={1}>
                  {k.summary ? "已做完，等另外几份" : (now?.title ?? "正在准备…")}
                </Text>
              </Card>
            </Pressable>
          );
        })}
      {r.plan.map((x, i) => {
        const a = r.approvals[x.id];
        return (
          <Card key={`${r.runId}:${x.id}`}>
            <View style={base.row}>
              <View
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 15,
                  backgroundColor: x.status === "done" ? C.green : C.raised,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text style={{ color: C.text }}>{x.status === "done" ? "✓" : i + 1}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={base.heading}>{x.title}</Text>
                <Text style={base.muted}>
                  {
                    (
                      {
                        pending: "等待中",
                        running: "正在执行",
                        awaiting_approval: "需要你的确认",
                        done: "已完成",
                        failed: "失败",
                        skipped: "已跳过",
                        cancelled: "已取消",
                      } as const
                    )[x.status]
                  }
                </Text>
              </View>
            </View>
            {r.outputs[x.id] && <Text style={[base.muted, { marginTop: 10 }]}>{r.outputs[x.id]}</Text>}
            {a && (
              <View style={{ gap: 10, marginTop: 14 }}>
                <Text style={base.text}>{a.action.summary}</Text>
                <Text selectable style={[base.muted, { backgroundColor: C.bg, padding: 10, borderRadius: 10 }]}>
                  {a.action.detail}
                </Text>
                <Text style={{ color: C.amber }}>
                  {a.reason} · 风险等级 L{a.level}
                </Text>
                <View style={base.row}>
                  <Button title="面容 ID 确认" onPress={() => void approve(x.id, true)} />
                  <Button title="拒绝" kind="danger" onPress={() => void approve(x.id, false)} />
                </View>
              </View>
            )}
          </Card>
        );
      })}
      {r.previews.map((x, i) => (
        <Button key={i} title={`打开网页预览 · :${x.port}`} icon="open-outline" kind="quiet" onPress={() => void WebBrowser.openBrowserAsync(x.url)} />
      ))}
      {r.downloads.map((x, i) => (
        <Button key={i} title={`下载 ${x.name}`} icon="download-outline" kind="quiet" onPress={() => void dl(x)} />
      ))}
      {!!r.variants?.length && (
        <>
          <Text style={base.heading}>{picked ? "已选定" : "左右滑动，挑一个"}</Text>
          <ScrollView horizontal pagingEnabled showsHorizontalScrollIndicator={false} snapToInterval={322} decelerationRate="fast">
            {r.variants.map((v) => {
              const chosen = picked === v.forkId;
              return (
                <Card key={v.forkId} style={{ width: 310, marginRight: 12, gap: 10, opacity: picked && !chosen ? 0.4 : 1, borderColor: chosen ? C.green : undefined, borderWidth: chosen ? 2 : undefined }}>
                  {v.screenshot ? (
                    <Image source={{ uri: `data:image/png;base64,${v.screenshot}` }} style={{ height: 380, borderRadius: 12, backgroundColor: C.bg }} resizeMode="cover" />
                  ) : (
                    <View style={{ height: 120, borderRadius: 12, backgroundColor: C.bg, alignItems: "center", justifyContent: "center" }}>
                      <Text style={base.muted}>{v.ok ? "这一版没有网页预览" : "这一版失败了"}</Text>
                    </View>
                  )}
                  <Text style={base.heading}>{v.approach.split("：")[0]}</Text>
                  <Text style={base.muted} numberOfLines={5}>
                    {v.summary}
                  </Text>
                  {v.previewUrl && <Button title="打开预览" icon="open-outline" kind="quiet" onPress={() => void WebBrowser.openBrowserAsync(v.previewUrl!)} />}
                  {!picked && v.ok && <Button title="就要这个" icon="checkmark-outline" onPress={() => void pick(v.forkId)} />}
                  {chosen && <Text style={{ color: C.green }}>✓ 已经成为你的云电脑，其余几台已删除</Text>}
                </Card>
              );
            })}
          </ScrollView>
          {!picked && <Button title="都不要" kind="quiet" onPress={() => void pick()} />}
        </>
      )}
      {hasSnapshot && <Button title="撤销整台机器" kind="danger" icon="arrow-undo-outline" onPress={undo} />}
    </ScrollView>
  );
}
