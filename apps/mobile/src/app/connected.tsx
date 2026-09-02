import { router, Stack } from "expo-router";
import { Button } from "heroui-native";
import { useThemeColor } from "heroui-native/hooks";
import { Bot, Layers3, Plus, Search, WifiOff } from "lucide-react-native";
import { FlatList, Pressable, Text, View } from "react-native";

import { useAppDrawer } from "@/components/app-drawer-shell";
import { BotListRow } from "@/components/bot-list-row";
import { isAndroid, isIOS } from "@/lib/platform";
import { useMobileWorkspace } from "@/providers/mobile-workspace-provider";

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

export default function Connected() {
  const { openDrawer } = useAppDrawer();
  const { activeBots, activeServer } = useMobileWorkspace();
  const [foreground, muted] = useThemeColor(["foreground", "muted"]);
  const iconColor = String(foreground);
  const mutedColor = String(muted);

  return (
    <>
      <FlatList
        className="flex-1 bg-background"
        contentContainerClassName="grow pb-safe-offset-8 pt-3"
        contentInsetAdjustmentBehavior="automatic"
        data={activeBots}
        keyExtractor={(bot) => bot.id}
        renderItem={({ item }) => <BotListRow bot={item} />}
        ListHeaderComponent={
          activeServer.state === "offline" ? (
            <View className="px-5 pb-3 pt-1">
              <View className="flex-row items-center gap-2 rounded-2xl bg-control px-3 py-2.5">
                <WifiOff color={mutedColor} size={17} strokeWidth={1.8} />
                <Text className="min-w-0 flex-1 font-sans text-caption text-text-secondary">
                  This server is offline. Showing the last available bot list.
                </Text>
              </View>
            </View>
          ) : null
        }
        ListEmptyComponent={
          <View className="flex-1 items-center justify-center gap-5 px-8 py-16">
            <View className="size-16 items-center justify-center rounded-3xl bg-control">
              <Bot color={mutedColor} size={30} strokeWidth={1.6} />
            </View>
            <View className="items-center gap-1.5">
              <Text className="font-sans text-title font-semibold text-foreground">No bots on this server</Text>
              <Text className="text-center font-sans text-body text-text-secondary">
                Add a bot to start working from your phone.
              </Text>
            </View>
            <Button size="md" variant="secondary" onPress={() => router.push("/add-bot")}>
              <Plus color={iconColor} size={18} strokeWidth={2} />
              <Button.Label>Add bot</Button.Label>
            </Button>
          </View>
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
                  <HeaderIconButton accessibilityLabel="Add bot" onPress={() => router.push("/add-bot")}>
                    <Plus color={iconColor} size={24} strokeWidth={1.9} />
                  </HeaderIconButton>
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
            <Stack.Toolbar.Menu icon="plus">
              <Stack.Toolbar.MenuAction icon="plus.circle" onPress={() => router.push("/add-bot")}>
                Add bot
              </Stack.Toolbar.MenuAction>
            </Stack.Toolbar.Menu>
          </Stack.Toolbar>
        </>
      ) : null}
    </>
  );
}
