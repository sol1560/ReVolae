import { Ionicons } from "@expo/vector-icons";
import { notify, pickDocument, saveAndShare } from "../../src/platform";
import React, { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import { useSession } from "../../src/session";
import { base, Button, Card, Empty } from "../../src/ui";
import { C } from "../../src/theme";
export default function Files() {
  const s = useSession(),
    [path, setPath] = useState("/home/user/work"),
    [busy, setBusy] = useState(false);
  const load = (p: string) => {
    setPath(p);
    void s.request({ type: "cloud.files.list", path: p }, "cloud.files").catch((e) => notify("读取失败", String(e)));
  };
  useEffect(() => load(path), []);
  const download = async (p: string) => {
    try {
      const d = await s.request({ type: "cloud.download.get", path: p }, "cloud.download");
      await saveAndShare(d.url, d.name);
    } catch (e) {
      notify("下载失败", String(e));
    }
  };
  const upload = async () => {
    const f = await pickDocument();
    if (!f) return;
    setBusy(true);
    try {
      await s.upload(f.name, f.blob);
      load(path);
    } catch (e) {
      notify("上传失败", String(e));
    } finally {
      setBusy(false);
    }
  };
  const crumbs = path.split("/").filter(Boolean);
  return (
    <ScrollView style={base.screen} contentContainerStyle={base.content}>
      <View style={base.between}>
        <Text style={base.title}>文件</Text>
        <Button title={busy ? "上传中…" : "上传"} icon="cloud-upload-outline" disabled={busy} onPress={() => void upload()} />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Pressable onPress={() => load("/home/user/work")}>
          <Text style={{ color: C.blue }}>工作目录</Text>
        </Pressable>
        {crumbs.slice(3).map((x, i) => (
          <Text key={i} style={base.muted}>
            {" "}
            / {x}
          </Text>
        ))}
      </ScrollView>
      {!s.state.files?.entries.length && <Empty icon="folder-open-outline" title="这里是空的" detail="上传文件，或让云电脑为你生成。" />}
      {s.state.files?.entries.map((x) => (
        <Pressable key={x.path} onPress={() => (x.type === "dir" ? load(x.path) : void download(x.path))}>
          <Card style={base.row}>
            <Ionicons name={x.type === "dir" ? "folder" : "document-outline"} color={x.type === "dir" ? C.blue : C.muted} size={24} />
            <View style={{ flex: 1 }}>
              <Text style={base.text}>{x.name}</Text>
              <Text style={base.muted}>{x.type === "dir" ? "文件夹" : `${Math.ceil(x.size / 1024)} KB`}</Text>
            </View>
            <Ionicons name="chevron-forward" color={C.muted} size={18} />
          </Card>
        </Pressable>
      ))}
    </ScrollView>
  );
}
