import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SessionProvider } from "../src/session";
import { C } from "../src/theme";
export default function Root() {
  return (
    <SessionProvider>
      <StatusBar style="light" />
      <Stack
        screenOptions={{ headerStyle: { backgroundColor: C.bg }, headerTintColor: C.text, contentStyle: { backgroundColor: C.bg }, headerShadowVisible: false }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="task/[id]" options={{ title: "任务详情", presentation: "card" }} />
      </Stack>
    </SessionProvider>
  );
}
