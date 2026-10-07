import { useRouter } from "expo-router";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSession } from "../../src/session";
import { runTitle } from "../../src/store";
import { base, Card, Empty } from "../../src/ui";
import { C } from "../../src/theme";
export default function Tasks() {
  const { state } = useSession(),
    r = useRouter();
  return (
    <ScrollView style={base.screen} contentContainerStyle={base.content}>
      <Text style={base.title}>任务</Text>
      <Text style={base.muted}>每一步都看得见，也随时能撤销</Text>
      {!state.order.length && <Empty icon="sparkles-outline" title="还没有任务" detail="去云电脑页，说一句你想完成的事。" />}
      {state.order.filter((id) => !state.runs[id]!.parentRunId).map((id) => {
        const x = state.runs[id]!;
        const kids = Object.values(state.runs).filter((k) => k.parentRunId === id);
        return (
          <Pressable key={id} onPress={() => r.push(`/task/${encodeURIComponent(id)}`)}>
            <Card>
              <View style={base.between}>
                <Text style={[base.heading, { flex: 1 }]} numberOfLines={1}>
                  {runTitle(state, x)}
                </Text>
                <Text style={{ color: x.ok === false ? C.red : x.summary ? C.green : C.amber }}>●</Text>
              </View>
              <Text style={base.muted}>
                {kids.length
                  ? x.variants
                    ? `${kids.length} 种做法都做完了，去挑一个`
                    : `同时试 ${kids.length} 种做法 · ${kids.filter((k) => k.summary).length} / ${kids.length} 完成`
                  : (x.summary ?? (x.plan.length ? `${x.plan.filter((s) => s.status === "done").length} / ${x.plan.length} 步完成` : "正在准备…"))}
              </Text>
            </Card>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}
