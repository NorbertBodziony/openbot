import "../../global.css";

import { QueryClientProvider } from "@tanstack/react-query";
import { usePathname } from "expo-router";
import { DarkTheme, DefaultTheme, ThemeProvider } from "expo-router/react-navigation";
import { Stack } from "expo-router/stack";
import { StatusBar } from "expo-status-bar";
import { HeroUINativeProvider } from "heroui-native/provider";
import { useLayoutEffect } from "react";
import { useColorScheme, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { withUniwind } from "uniwind";

import { MobileSessionProvider, useMobileSession } from "@/features/auth/context/mobile-session-context";
import { AppLoadingOverlayProvider, useAppLoadingOverlay } from "@/shared/components/app-loading-overlay";
import { BloubAnimationProvider } from "@/shared/components/bloub-loader";
import { isIOS } from "@/shared/lib/platform";
import { queryClient } from "@/shared/lib/query-client";

export const unstable_settings = {
  initialRouteName: "index",
};

const UniwindGestureHandlerRootView = withUniwind(GestureHandlerRootView);

function RootNavigator() {
  const { loading, session } = useMobileSession();
  const pathname = usePathname();
  const { setLoadingLabel, isLoaderPresent } = useAppLoadingOverlay();

  useLayoutEffect(() => {
    if (loading) setLoadingLabel("Loading account");
    else if (!session || (pathname !== "/" && pathname !== "/connected")) setLoadingLabel(null);
    // Keep the loader visible until ConnectedScreen reports the workspace state.
  }, [loading, pathname, session, setLoadingLabel]);

  if (loading || (!session && isLoaderPresent)) {
    return <View className="flex-1 bg-background" />;
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
        <Stack.Screen name="(app)" options={{ animation: "fade", gestureEnabled: false, headerShown: false }} />
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
            <BloubAnimationProvider>
              <MobileSessionProvider>
                <AppLoadingOverlayProvider>
                  <RootNavigator />
                </AppLoadingOverlayProvider>
              </MobileSessionProvider>
            </BloubAnimationProvider>
          </ThemeProvider>
        </HeroUINativeProvider>
      </QueryClientProvider>
    </UniwindGestureHandlerRootView>
  );
}
