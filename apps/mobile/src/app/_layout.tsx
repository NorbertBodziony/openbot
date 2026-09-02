import "../../global.css";

import { QueryClientProvider } from "@tanstack/react-query";
import { DarkTheme, DefaultTheme, ThemeProvider } from "expo-router/react-navigation";
import { Stack } from "expo-router/stack";
import { StatusBar } from "expo-status-bar";
import { Spinner } from "heroui-native";
import { HeroUINativeProvider } from "heroui-native/provider";
import { useColorScheme, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { withUniwind } from "uniwind";

import { isIOS } from "@/lib/platform";
import { queryClient } from "@/lib/query-client";
import { MobileSessionProvider, useMobileSession } from "@/providers/mobile-session-provider";

const UniwindGestureHandlerRootView = withUniwind(GestureHandlerRootView);

function AppNavigation() {
  const { loading, session } = useMobileSession();
  if (loading) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <Spinner color="default" accessibilityLabel="Loading account" />
      </View>
    );
  }

  return (
    <Stack
      screenOptions={{
        headerBackButtonDisplayMode: "minimal",
        headerShadowVisible: false,
        headerTransparent: isIOS,
      }}
    >
      <Stack.Protected guard={!session}>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="scan-qr-code" options={{ animation: "slide_from_right", title: "Scan QR code" }} />
      </Stack.Protected>
      <Stack.Protected guard={Boolean(session)}>
        <Stack.Screen name="connected" options={{ animation: "fade", gestureEnabled: false, title: "" }} />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  const colorScheme = useColorScheme();

  return (
    <UniwindGestureHandlerRootView className="flex-1">
      <QueryClientProvider client={queryClient}>
        <HeroUINativeProvider>
          <ThemeProvider value={colorScheme === "dark" ? DarkTheme : DefaultTheme}>
            <StatusBar style="auto" />
            <MobileSessionProvider>
              <AppNavigation />
            </MobileSessionProvider>
          </ThemeProvider>
        </HeroUINativeProvider>
      </QueryClientProvider>
    </UniwindGestureHandlerRootView>
  );
}
