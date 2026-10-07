// 必须在 App 代码之前加载（index.js 第一行导入）。
// @cuaremote/protocol 用 crypto.getRandomValues（@noble 生成密钥）和 crypto.randomUUID（消息 id）。
import "react-native-get-random-values";
import * as Crypto from "expo-crypto";

const g = globalThis as { crypto?: { randomUUID?: () => string } };
g.crypto ??= {};
g.crypto.randomUUID ??= Crypto.randomUUID;
