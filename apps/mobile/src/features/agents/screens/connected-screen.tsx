import { type MenuAction, MenuView } from "@expo/ui/community/menu";
import { router, Stack } from "expo-router";
import { Button, Typography } from "heroui-native";
import { useThemeColor } from "heroui-native/hooks";
import { Bot, Ellipsis, Layers3, Plus, Search, WifiOff } from "lucide-react-native";
import { useMemo } from "react";
import { ActivityIndicator, FlatList, Pressable, View } from "react-native";
import Animated, { Easing, FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";

import { AgentListRow } from "@/features/agents/components/agent-list-row";
import { useAgentPinTransition } from "@/features/agents/components/agent-pin-transition";
import { PinnedAgentsStrip } from "@/features/agents/components/pinned-agents-strip";
import { useAppDrawer } from "@/features/servers/components/app-drawer-shell";
import { ConnectionStatus } from "@/features/workspace/components/connection-status";
import { type MobileAgent, useMobileWorkspace } from "@/features/workspace/context/mobile-workspace-context";
import { isAndroid, isIOS } from "@/shared/lib/platform";

const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);
const EASE_IN_OUT = Easing.bezier(0.77, 0, 0.175, 1);
const ROW_ENTER = FadeIn.duration(180).easing(EASE_IN_OUT).reduceMotion(ReduceMotion.System);
const ROW_EXIT = FadeOut.duration(120).easing(EASE_OUT).reduceMotion(ReduceMotion.System);
// Agent search is not available in the current mobile release, so keep its entry points hidden until it is ready.
const IS_AGENT_SEARCH_ENABLED = false;

function TransitioningAgentRow({ agent }: { agent: MobileAgent }) {
  const { transition } = useAgentPinTransition();
  const isTarget = transition?.agentId === agent.id && transition.target === "row";
  const isSource = transition?.agentId === agent.id && transition.source === "row";

  return (
    <Animated.View entering={isTarget ? ROW_ENTER : undefined} exiting={isSource ? ROW_EXIT : undefined}>
      <AgentListRow agent={agent} leftInset={15} rightInset={24} />
    </Animated.View>
  );
}

function HeaderIconButton({
  accessibilityLabel,
  children,
  onPress,
}: {
  accessibilityLabel: string;
  children: React.ReactNode;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      hitSlop={4}
      className="size-11 items-center justify-center rounded-full"
      onPress={onPress}
    >
      {children}
    </Pressable>
  );
}

export function ConnectedScreen() {
  const { openDrawer } = useAppDrawer();
  const {
    activeAgents,
    activeServer,
    hiddenAgents,
    pinnedAgentIds,
    refreshServers,
    serverDirectoryError,
    serverDirectoryState,
    servers,
  } = useMobileWorkspace();
  const [foreground, muted] = useThemeColor(["foreground", "muted"]);
  const iconColor = String(foreground);
  const mutedColor = String(muted);
  const hasSelectedServer = servers.some((server) => server.id === activeServer.id);
  const pinnedAgents = pinnedAgentIds
    .map((agentId) => activeAgents.find((agent) => agent.id === agentId))
    .filter((agent): agent is (typeof activeAgents)[number] => Boolean(agent));
  const unpinnedAgents = activeAgents.filter((agent) => !pinnedAgentIds.includes(agent.id));
  const optionsActions = useMemo<MenuAction[]>(
    () => [
      { id: "add-agent", title: "Add agent" },
      ...(hiddenAgents.length > 0 ? [{ id: "hidden-chats", title: "Hidden chats" }] : []),
    ],
    [hiddenAgents.length],
  );

  return (
    <>
      <FlatList
        className="flex-1 bg-background"
        contentContainerClassName="grow pb-safe-offset-8 pt-3"
        contentInsetAdjustmentBehavior="automatic"
        data={unpinnedAgents}
        keyExtractor={(agent) => agent.id}
        renderItem={({ item }) => <TransitioningAgentRow agent={item} />}
        ListHeaderComponent={
          <>
            <PinnedAgentsStrip agents={pinnedAgents} />
            {hasSelectedServer ? <ConnectionStatus server={activeServer} /> : null}
          </>
        }
        ListEmptyComponent={
          serverDirectoryState === "loading" && servers.length === 0 ? (
            <View className="flex-1 items-center justify-center gap-4 px-8 py-16">
              <ActivityIndicator color={mutedColor} />
              <Typography.Paragraph className="text-text-secondary">Loading your servers…</Typography.Paragraph>
            </View>
          ) : serverDirectoryState === "error" && servers.length === 0 ? (
            <View className="flex-1 items-center justify-center gap-5 px-8 py-16">
              <View className="size-16 items-center justify-center rounded-3xl bg-control">
                <WifiOff color={mutedColor} size={28} strokeWidth={1.6} />
              </View>
              <View className="items-center gap-1.5">
                <Typography.Heading type="h4">Couldn’t load your servers</Typography.Heading>
                <Typography.Paragraph align="center" className="text-text-secondary">
                  {serverDirectoryError ?? "Check that the desktop app is running and try again."}
                </Typography.Paragraph>
              </View>
              <Button size="md" variant="secondary" onPress={() => void refreshServers().catch(() => undefined)}>
                <Button.Label>Try again</Button.Label>
              </Button>
            </View>
          ) : servers.length === 0 ? (
            <View className="flex-1 items-center justify-center gap-5 px-8 py-16">
              <View className="size-16 items-center justify-center rounded-3xl bg-control">
                <Layers3 color={mutedColor} size={28} strokeWidth={1.6} />
              </View>
              <View className="items-center gap-1.5">
                <Typography.Heading type="h4">No servers available</Typography.Heading>
                <Typography.Paragraph align="center" className="text-text-secondary">
                  Connect the desktop app again or join a remote server.
                </Typography.Paragraph>
              </View>
            </View>
          ) : !hasSelectedServer ? (
            <View className="flex-1 items-center justify-center gap-5 px-8 py-16">
              <Typography.Heading type="h4">Choose a server</Typography.Heading>
              <Button size="md" variant="secondary" onPress={openDrawer}>
                <Button.Label>Open servers</Button.Label>
              </Button>
            </View>
          ) : activeAgents.length === 0 ? (
            <View className="flex-1 items-center justify-center gap-5 px-8 py-16">
              <View className="size-16 items-center justify-center rounded-3xl bg-control">
                <Bot color={mutedColor} size={30} strokeWidth={1.6} />
              </View>
              <View className="items-center gap-1.5">
                <Typography.Heading type="h4">No agents on this server</Typography.Heading>
                <Typography.Paragraph align="center" className="text-text-secondary">
                  Add an agent to start working from your phone.
                </Typography.Paragraph>
              </View>
              <Button size="md" variant="secondary" onPress={() => router.push("/add-agent")}>
                <Plus color={iconColor} size={18} strokeWidth={2} />
                <Button.Label>Add agent</Button.Label>
              </Button>
            </View>
          ) : null
        }
      />

      <Stack.Screen
        options={{
          headerLeft: isAndroid
            ? () => (
                <HeaderIconButton accessibilityLabel="Open servers" onPress={openDrawer}>
                  <Layers3 color={iconColor} size={22} strokeWidth={1.8} />
                </HeaderIconButton>
              )
            : undefined,
          headerRight: isAndroid
            ? () => (
                <View className="flex-row items-center gap-1">
                  {IS_AGENT_SEARCH_ENABLED ? (
                    <HeaderIconButton accessibilityLabel="Search agents" onPress={() => router.push("/search-agents")}>
                      <Search color={iconColor} size={22} strokeWidth={1.9} />
                    </HeaderIconButton>
                  ) : null}
                  <MenuView
                    actions={optionsActions}
                    onPressAction={(event) => {
                      if (event.nativeEvent.event === "add-agent") router.push("/add-agent");
                      if (event.nativeEvent.event === "hidden-chats") router.push("/hidden-chats");
                    }}
                    style={{ height: 44, width: 44 }}
                  >
                    <View
                      accessibilityLabel="More options"
                      accessibilityRole="button"
                      accessible
                      className="size-11 items-center justify-center rounded-full"
                    >
                      <Ellipsis color={iconColor} size={24} strokeWidth={1.9} />
                    </View>
                  </MenuView>
                </View>
              )
            : undefined,
          headerTintColor: foreground,
          title: "",
        }}
      />

      {isIOS ? (
        <>
          <Stack.Toolbar placement="left">
            <Stack.Toolbar.Button icon="square.stack.3d.up.fill" onPress={openDrawer} />
          </Stack.Toolbar>
          <Stack.Toolbar placement="right">
            {IS_AGENT_SEARCH_ENABLED ? (
              <Stack.Toolbar.Button icon="magnifyingglass" onPress={() => router.push("/search-agents")} />
            ) : null}
            <Stack.Toolbar.Menu icon="ellipsis">
              <Stack.Toolbar.MenuAction icon="plus.circle" onPress={() => router.push("/add-agent")}>
                Add agent
              </Stack.Toolbar.MenuAction>
              {hiddenAgents.length > 0 ? (
                <Stack.Toolbar.MenuAction icon="eye.slash" onPress={() => router.push("/hidden-chats")}>
                  Hidden chats
                </Stack.Toolbar.MenuAction>
              ) : null}
            </Stack.Toolbar.Menu>
          </Stack.Toolbar>
        </>
      ) : null}
    </>
  );
}
