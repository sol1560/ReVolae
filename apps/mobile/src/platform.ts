// iPhone / Android：钥匙串存身份、面容 ID、下载后弹系统分享面板。网页预览版见 platform.web.ts。
import * as FileSystem from "expo-file-system/legacy";
import * as LocalAuthentication from "expo-local-authentication";
import * as SecureStore from "expo-secure-store";
import * as Sharing from "expo-sharing";
import { Alert } from "react-native";

export const secureGet = (k: string) => SecureStore.getItemAsync(k);
export const secureSet = (k: string, v: string) => SecureStore.setItemAsync(k, v);

export async function authenticate(prompt: string): Promise<boolean> {
  return (await LocalAuthentication.authenticateAsync({ promptMessage: prompt, cancelLabel: "取消" })).success;
}

export async function saveAndShare(url: string, name: string) {
  const to = FileSystem.cacheDirectory + name;
  await FileSystem.downloadAsync(url, to);
  await Sharing.shareAsync(to);
}

export const defaultHubURL = () => process.env.EXPO_PUBLIC_HUB_URL ?? "ws://localhost:8788/ws";
export const isWebPreview = false;

export function confirm(title: string, detail: string, ok: string): Promise<boolean> {
  return new Promise((resolve) =>
    Alert.alert(title, detail, [
      { text: "取消", style: "cancel", onPress: () => resolve(false) },
      { text: ok, style: "destructive", onPress: () => resolve(true) },
    ]),
  );
}

export function notify(title: string, detail?: string) {
  Alert.alert(title, detail);
}

/** 选一个文件；取消返回 undefined */
export async function pickDocument(): Promise<{ name: string; blob: Blob } | undefined> {
  const DocumentPicker = await import("expo-document-picker");
  const r = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
  if (r.canceled) return undefined;
  const a = r.assets[0]!;
  return { name: a.name, blob: await (await fetch(a.uri)).blob() };
}
