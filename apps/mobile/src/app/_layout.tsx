import "../../global.css";

import { QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router/stack";
import { StatusBar } from "expo-status-bar";
import { HeroUINativeProvider } from "heroui-native/provider";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { withUniwind } from "uniwind";

import { queryClient } from "@/lib/query-client";

const UniwindGestureHandlerRootView = withUniwind(GestureHandlerRootView);

export default function RootLayout() {
  return (
    <UniwindGestureHandlerRootView className="flex-1">
      <QueryClientProvider client={queryClient}>
        <HeroUINativeProvider>
          <StatusBar style="auto" />
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="index" />
            <Stack.Screen name="scan-qr-code" options={{ animation: "slide_from_right" }} />
          </Stack>
        </HeroUINativeProvider>
      </QueryClientProvider>
    </UniwindGestureHandlerRootView>
  );
}
