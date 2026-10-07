import { Ionicons } from "@expo/vector-icons";
import React from "react";
import { Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native";
import { C } from "./theme";
export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[s.card, style]}>{children}</View>;
}
export function Button({
  title,
  onPress,
  kind = "primary",
  disabled = false,
  icon,
}: {
  title: string;
  onPress: () => void;
  kind?: "primary" | "quiet" | "danger";
  disabled?: boolean;
  icon?: keyof typeof Ionicons.glyphMap;
}) {
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [s.button, kind === "quiet" && s.quiet, kind === "danger" && s.danger, (pressed || disabled) && { opacity: 0.55 }]}
    >
      {icon && <Ionicons name={icon} size={17} color={C.text} />}
      <Text style={s.buttonText}>{title}</Text>
    </Pressable>
  );
}
export function Empty({ icon, title, detail }: { icon: keyof typeof Ionicons.glyphMap; title: string; detail: string }) {
  return (
    <View style={s.empty}>
      <Ionicons name={icon} size={38} color={C.muted} />
      <Text style={s.emptyTitle}>{title}</Text>
      <Text style={s.muted}>{detail}</Text>
    </View>
  );
}
export const base = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  content: { padding: 20, gap: 14, paddingBottom: 40 },
  title: { fontSize: 30, fontWeight: "800", color: C.text, letterSpacing: -0.7 },
  heading: { fontSize: 18, fontWeight: "700", color: C.text },
  text: { fontSize: 15, color: C.text },
  muted: { fontSize: 13, color: C.muted, lineHeight: 19 },
  input: { backgroundColor: C.panel, color: C.text, borderRadius: 16, padding: 16, fontSize: 16, borderWidth: 1, borderColor: C.line },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  between: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
});
const s = StyleSheet.create({
  card: { backgroundColor: C.panel, borderRadius: 20, padding: 16, borderWidth: 1, borderColor: C.line },
  button: {
    minHeight: 44,
    borderRadius: 14,
    paddingHorizontal: 16,
    backgroundColor: C.blue,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 7,
  },
  quiet: { backgroundColor: C.raised },
  danger: { backgroundColor: "#51262D" },
  buttonText: { fontWeight: "700", color: C.text },
  empty: { padding: 50, alignItems: "center", gap: 10 },
  emptyTitle: { fontSize: 18, fontWeight: "700", color: C.text },
  muted: { textAlign: "center", color: C.muted },
});
