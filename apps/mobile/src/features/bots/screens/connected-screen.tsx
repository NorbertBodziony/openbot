import { type MenuAction, MenuView } from "@expo/ui/community/menu";
import { router, Stack } from "expo-router";
import { Button, Typography } from "heroui-native";
import { useThemeColor } from "heroui-native/hooks";
import { Bot, Ellipsis, Layers3, Plus, Search, WifiOff } from "lucide-react-native";
import { useMemo } from "react";
import { FlatList, Pressable, View } from "react-native";
import Animated, { Easing, FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";

import { BotListRow } from "@/features/bots/components/bot-list-row";
import { useBotPinTransition } from "@/features/bots/components/bot-pin-transition";
import { PinnedBotsStrip } from "@/features/bots/components/pinned-bots-strip";
import { useAppDrawer } from "@/features/servers/components/app-drawer-shell";
import { type MobileBot, useMobileWorkspace } from "@/features/workspace/context/mobile-workspace-context";
import { isAndroid, isIOS } from "@/shared/lib/platform";

const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);
const EASE_IN_OUT = Easing.bezier(0.77, 0, 0.175, 1);
const ROW_ENTER = FadeIn.duration(180).easing(EASE_IN_OUT).reduceMotion(ReduceMotion.System);
const ROW_EXIT = FadeOut.duration(120).easing(EASE_OUT).reduceMotion(ReduceMotion.System);

function TransitioningBotRow({ bot }: { bot: MobileBot }) {
  const { transition } = useBotPinTransition();
  const isTarget = transition?.botId === bot.id && transition.target === "row";
  const isSource = transition?.botId === bot.id && transition.source === "row";

  return (
    <Animated.View entering={isTarget ? ROW_ENTER : undefined} exiting={isSource ? ROW_EXIT : undefined}>
      <BotListRow bot={bot} leftInset={15} rightInset={24} />
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
  const { activeBots, activeServer, hiddenBots, pinnedBotIds } = useMobileWorkspace();
  const [foreground, muted] = useThemeColor(["foreground", "muted"]);
  const iconColor = String(foreground);
  const mutedColor = String(muted);
  const pinnedBots = pinnedBotIds
    .map((botId) => activeBots.find((bot) => bot.id === botId))
    .filter((bot): bot is (typeof activeBots)[number] => Boolean(bot));
  const unpinnedBots = activeBots.filter((bot) => !pinnedBotIds.includes(bot.id));
  const optionsActions = useMemo<MenuAction[]>(
    () => [
      { id: "add-bot", title: "Add bot" },
      ...(hiddenBots.length > 0 ? [{ id: "hidden-chats", title: "Hidden chats" }] : []),
    ],
    [hiddenBots.length],
  );

  return (
    <>
      <FlatList
        className="flex-1 bg-background"
        contentContainerClassName="grow pb-safe-offset-8 pt-3"
        contentInsetAdjustmentBehavior="automatic"
        data={unpinnedBots}
        keyExtractor={(bot) => bot.id}
        renderItem={({ item }) => <TransitioningBotRow bot={item} />}
        ListHeaderComponent={
          <>
            <PinnedBotsStrip bots={pinnedBots} />
            {activeServer.state === "offline" ? (
              <View className="px-5 pb-3 pt-1">
                <View className="flex-row items-center gap-2 rounded-2xl bg-control px-3 py-2.5">
                  <WifiOff color={mutedColor} size={17} strokeWidth={1.8} />
                  <Typography.Paragraph type="body-xs" className="min-w-0 flex-1 text-text-secondary">
                    This server is offline. Showing the last available bot list.
                  </Typography.Paragraph>
                </View>
              </View>
            ) : null}
          </>
        }
        ListEmptyComponent={
          activeBots.length === 0 ? (
            <View className="flex-1 items-center justify-center gap-5 px-8 py-16">
              <View className="size-16 items-center justify-center rounded-3xl bg-control">
                <Bot color={mutedColor} size={30} strokeWidth={1.6} />
              </View>
              <View className="items-center gap-1.5">
                <Typography.Heading type="h4">No bots on this server</Typography.Heading>
                <Typography.Paragraph align="center" className="text-text-secondary">
                  Add a bot to start working from your phone.
                </Typography.Paragraph>
              </View>
              <Button size="md" variant="secondary" onPress={() => router.push("/add-bot")}>
                <Plus color={iconColor} size={18} strokeWidth={2} />
                <Button.Label>Add bot</Button.Label>
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
                  <HeaderIconButton accessibilityLabel="Search bots" onPress={() => router.push("/search-bots")}>
                    <Search color={iconColor} size={22} strokeWidth={1.9} />
                  </HeaderIconButton>
                  <MenuView
                    actions={optionsActions}
                    onPressAction={(event) => {
                      if (event.nativeEvent.event === "add-bot") router.push("/add-bot");
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
            <Stack.Toolbar.Button icon="magnifyingglass" onPress={() => router.push("/search-bots")} />
            <Stack.Toolbar.Menu icon="ellipsis">
              <Stack.Toolbar.MenuAction icon="plus.circle" onPress={() => router.push("/add-bot")}>
                Add bot
              </Stack.Toolbar.MenuAction>
              {hiddenBots.length > 0 ? (
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
