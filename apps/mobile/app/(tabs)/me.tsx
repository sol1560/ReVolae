import { notify } from "../../src/platform";
import Purchases from "react-native-purchases";
import RevenueCatUI from "react-native-purchases-ui";
import React, { useState } from "react";
import { Alert, ScrollView, Text, TextInput, View } from "react-native";
import { useSession } from "../../src/session";
import { base, Button, Card } from "../../src/ui";
import { C } from "../../src/theme";
export default function Me() {
  const s = useSession(),
    [url, setURL] = useState(s.hubURL);
  const sync = async () => {
    s.refresh();
    await s.refreshPurchases();
  };
  const buy = async () => {
    if (!process.env.EXPO_PUBLIC_REVENUECAT_API_KEY) {
      notify("尚未配置 RevenueCat", "请在 .env 中设置 Test Store API key。");
      return;
    }
    try {
      const result = await RevenueCatUI.presentPaywall();
      if (result === RevenueCatUI.PAYWALL_RESULT.NOT_PRESENTED) {
        const o = await Purchases.getOfferings();
        const p = o.current?.availablePackages[0];
        if (p) await Purchases.purchasePackage(p);
      }
      await sync();
    } catch (e) {
      notify("购买未完成", String(e));
    }
  };
  const restore = async () => {
    try {
      await Purchases.restorePurchases();
      await sync();
      notify("已恢复购买");
    } catch (e) {
      notify("恢复失败", String(e));
    }
  };
  return (
    <ScrollView style={base.screen} contentContainerStyle={base.content}>
      <Text style={base.title}>我的</Text>
      <Card>
        <Text style={base.muted}>账户 ID</Text>
        <Text style={base.text} selectable>
          {s.accountId ?? "连接后显示"}
        </Text>
      </Card>
      <View style={base.row}>
        <Card style={{ flex: 1 }}>
          <Text style={base.muted}>可用额度</Text>
          <Text style={[base.title, { fontSize: 24, color: C.amber }]}>{s.state.billing?.credits ?? 0} CRD</Text>
        </Card>
        <Card style={{ flex: 1 }}>
          <Text style={base.muted}>免费次数</Text>
          <Text style={[base.title, { fontSize: 24 }]}>
            {s.state.billing?.freeRunsUsed ?? 0}/{s.state.billing?.freeRunsTotal ?? 0}
          </Text>
        </Card>
      </View>
      <Card>
        <View style={base.between}>
          <View>
            <Text style={base.heading}>Pro</Text>
            <Text style={base.muted}>{s.pro ? "已解锁 3 种做法" : "升级后可同时尝试 3 种方案"}</Text>
          </View>
          <Text style={{ color: s.pro ? C.green : C.muted }}>{s.pro ? "已启用" : "未启用"}</Text>
        </View>
        <View style={[base.row, { marginTop: 14 }]}>
          <Button title="购买额度" onPress={() => void buy()} />
          <Button title="恢复购买" kind="quiet" onPress={() => void restore()} />
        </View>
      </Card>
      <Text style={base.heading}>连接设置</Text>
      <TextInput value={url} onChangeText={setURL} autoCapitalize="none" autoCorrect={false} style={base.input} />
      <Button title="保存并重新连接" kind="quiet" onPress={() => void s.setHubURL(url.trim())} />
      <Card>
        <Text style={base.heading}>隐私说明</Text>
        <Text style={[base.muted, { marginTop: 7 }]}>云电脑模式下服务器能看到你的任务内容。手机与云电脑之间的控制通道使用端到端加密。</Text>
      </Card>
    </ScrollView>
  );
}
