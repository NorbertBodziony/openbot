import { Stack } from "expo-router/stack";
import { useThemeColor } from "heroui-native/hooks";

import { useMobileSession } from "@/features/auth/context/mobile-session-context";
import { BotPinTransitionProvider } from "@/features/bots/components/bot-pin-transition";
import { AppDrawerShell } from "@/features/servers/components/app-drawer-shell";
import { MobileWorkspaceProvider } from "@/features/workspace/context/mobile-workspace-context";
import { isIOS } from "@/shared/lib/platform";

export const unstable_settings = {
  initialRouteName: "connected",
};

function AuthenticatedStack() {
  const background = useThemeColor("background");

  return (
    <Stack
      screenOptions={{
        headerBackButtonDisplayMode: "minimal",
        headerShadowVisible: false,
        headerTransparent: isIOS,
      }}
    >
      <Stack.Screen name="connected" options={{ animation: "fade", gestureEnabled: false, title: "" }} />
      <Stack.Screen
        name="chat/[botId]"
        options={{
          animation: "slide_from_right",
          contentStyle: { backgroundColor: background },
          fullScreenGestureEnabled: false,
          gestureEnabled: true,
          headerShown: false,
        }}
      />
      <Stack.Screen
        name="add-bot"
        options={{
          contentStyle: { backgroundColor: background },
          headerStyle: { backgroundColor: background },
          headerTransparent: false,
          presentation: "formSheet",
          sheetAllowedDetents: "fitToContents",
          sheetGrabberVisible: true,
          title: "Add bot",
        }}
      />
      <Stack.Screen
        name="edit-bot/[botId]"
        options={{
          contentStyle: { backgroundColor: background },
          headerStyle: { backgroundColor: background },
          headerTransparent: false,
          presentation: "formSheet",
          sheetAllowedDetents: "fitToContents",
          sheetGrabberVisible: true,
          title: "Edit bot",
        }}
      />
      <Stack.Screen
        name="add-server"
        options={{
          contentStyle: { backgroundColor: background },
          headerShown: false,
          presentation: "formSheet",
          sheetAllowedDetents: "fitToContents",
          sheetGrabberVisible: true,
        }}
      />
      <Stack.Screen
        name="search-bots"
        options={{
          contentStyle: { backgroundColor: background },
          headerShown: false,
          presentation: "formSheet",
          sheetAllowedDetents: [1],
          sheetGrabberVisible: true,
          sheetInitialDetentIndex: "last",
        }}
      />
      <Stack.Screen
        name="hidden-chats"
        options={{
          contentStyle: { backgroundColor: background },
          headerShown: false,
          presentation: "formSheet",
          sheetAllowedDetents: "fitToContents",
          sheetGrabberVisible: true,
        }}
      />
      <Stack.Screen
        name="settings"
        options={{
          contentStyle: { backgroundColor: background },
          headerShown: false,
          presentation: "formSheet",
          sheetAllowedDetents: "fitToContents",
          sheetGrabberVisible: true,
        }}
      />
    </Stack>
  );
}

export default function AuthenticatedLayout() {
  const { session } = useMobileSession();
  const workspaceKey = session ? `${session.apiUrl}:${session.user.id}` : "signed-out";

  return (
    <MobileWorkspaceProvider key={workspaceKey}>
      <BotPinTransitionProvider>
        <AppDrawerShell>
          <AuthenticatedStack />
        </AppDrawerShell>
      </BotPinTransitionProvider>
    </MobileWorkspaceProvider>
  );
}
