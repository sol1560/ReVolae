import { Ionicons } from "@expo/vector-icons";
import { Tabs } from "expo-router";
import type { ColorValue } from "react-native";
import { C } from "../../src/theme";
const icon =
  (name: keyof typeof Ionicons.glyphMap) =>
  ({ color, size }: { color: ColorValue; size: number }) => <Ionicons name={name} color={color} size={size} />;
export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: C.blue,
        tabBarInactiveTintColor: C.muted,
        tabBarStyle: { backgroundColor: C.panel, borderTopColor: C.line, height: 84, paddingTop: 7 },
      }}
    >
      <Tabs.Screen name="index" options={{ title: "云电脑", tabBarIcon: icon("cloud-outline") }} />
      <Tabs.Screen name="tasks" options={{ title: "任务", tabBarIcon: icon("sparkles-outline") }} />
      <Tabs.Screen name="files" options={{ title: "文件", tabBarIcon: icon("folder-outline") }} />
      <Tabs.Screen name="terminal" options={{ title: "终端", tabBarIcon: icon("terminal-outline") }} />
      <Tabs.Screen name="me" options={{ title: "我的", tabBarIcon: icon("person-circle-outline") }} />
    </Tabs>
  );
}
