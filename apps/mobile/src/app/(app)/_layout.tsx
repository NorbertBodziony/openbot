import { Stack } from "expo-router/stack";
import { useThemeColor } from "heroui-native/hooks";
import { BotPinTransitionProvider } from "@/features/agents/components/agent-pin-transition";
import { useMobileSession } from "@/features/auth/context/mobile-session-context";
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
        name="chat/[agentId]"
        options={{
          animation: "slide_from_right",
          contentStyle: { backgroundColor: background },
          fullScreenGestureEnabled: false,
          gestureEnabled: false,
          headerShown: false,
        }}
      />
      <Stack.Screen
        name="add-agent"
        options={{
          contentStyle: { backgroundColor: background },
          headerStyle: { backgroundColor: background },
          headerTransparent: false,
          presentation: "formSheet",
          sheetAllowedDetents: "fitToContents",
          sheetGrabberVisible: true,
          title: "Add agent",
        }}
      />
      <Stack.Screen
        name="edit-agent/[agentId]"
        options={{
          contentStyle: { backgroundColor: background },
          headerStyle: { backgroundColor: background },
          headerTransparent: false,
          presentation: "formSheet",
          sheetAllowedDetents: "fitToContents",
          sheetGrabberVisible: true,
          title: "Edit agent",
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
        name="search-agents"
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
