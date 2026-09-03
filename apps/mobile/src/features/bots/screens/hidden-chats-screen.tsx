import * as Haptics from "expo-haptics";
import { Link, router } from "expo-router";
import { Typography } from "heroui-native";
import { useThemeColor } from "heroui-native/hooks";
import { Eye } from "lucide-react-native";
import { Pressable, View } from "react-native";

import { BloubAvatar } from "@/features/bots/components/bloub-avatar";
import { useMobileWorkspace } from "@/features/workspace/context/mobile-workspace-context";
import { SheetScrollView } from "@/shared/components/sheet-scroll-view";
import { isIOS } from "@/shared/lib/platform";

export function HiddenChatsScreen() {
  const { hiddenBots, unhideBot } = useMobileWorkspace();
  const foreground = useThemeColor("foreground");

  function showBot(botId: string): void {
    unhideBot(botId);
    if (isIOS) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    if (hiddenBots.length === 1) router.back();
  }

  return (
    <SheetScrollView contentContainerClassName="gap-5 px-5 pb-safe-offset-5 pt-7">
      <View className="items-center gap-2 px-4">
        <Typography.Heading type="h4" align="center">
          Hidden chats
        </Typography.Heading>
        <Typography.Paragraph type="body-xs" align="center" className="text-text-secondary">
          Hidden bots keep working. They&apos;re just not shown on the home screen.
        </Typography.Paragraph>
      </View>

      <View className="overflow-hidden rounded-3xl bg-control">
        {hiddenBots.map((bot) => (
          <View key={bot.id} className="min-h-18 flex-row items-center gap-2 px-3 py-2">
            <Link
              href={{ pathname: "/chat/[botId]", params: { botId: bot.id } }}
              asChild
              dismissTo
              onPress={() => {
                if (isIOS) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft);
              }}
            >
              <Link.Trigger>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Open chat with ${bot.name}`}
                  className="min-w-0 flex-1 flex-row items-center gap-3 rounded-2xl px-1 py-1"
                  style={({ pressed }) => ({ opacity: pressed ? 0.58 : 1 })}
                >
                  <BloubAvatar hue={bot.avatarHue} seed={bot.avatarSeed} size={46} />
                  <Typography.Paragraph className="min-w-0 flex-1" weight="semibold" numberOfLines={1}>
                    {bot.name}
                  </Typography.Paragraph>
                </Pressable>
              </Link.Trigger>
            </Link>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Show ${bot.name}`}
              className="min-h-10 flex-row items-center gap-1.5 rounded-full bg-control-active px-3"
              onPress={() => showBot(bot.id)}
            >
              <Eye color={String(foreground)} size={16} strokeWidth={1.9} />
              <Typography.Paragraph type="body-xs" weight="semibold">
                Show
              </Typography.Paragraph>
            </Pressable>
          </View>
        ))}
      </View>
    </SheetScrollView>
  );
}
