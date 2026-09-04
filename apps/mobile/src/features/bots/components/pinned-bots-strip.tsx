import * as Haptics from "expo-haptics";
import { Link } from "expo-router";
import { Typography } from "heroui-native";
import { useThemeColor } from "heroui-native/hooks";
import { Pressable, ScrollView, View } from "react-native";
import Animated, {
  CurvedTransition,
  Easing,
  FadeIn,
  FadeOut,
  LinearTransition,
  ReduceMotion,
} from "react-native-reanimated";

import { BloubAvatar } from "@/features/bots/components/bloub-avatar";
import { useBotContextMenu } from "@/features/bots/components/bot-context-menu";
import { BotPinAvatar } from "@/features/bots/components/bot-pin-avatar";
import { type MobileBot, useMobileWorkspace } from "@/features/workspace/context/mobile-workspace-context";
import { isIOS } from "@/shared/lib/platform";

const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);
const EASE_IN_OUT = Easing.bezier(0.77, 0, 0.175, 1);
const PINNED_LAYOUT = LinearTransition.duration(220).easing(EASE_IN_OUT).reduceMotion(ReduceMotion.System);
const PINNED_ITEM_LAYOUT = CurvedTransition.duration(240)
  .easingX(EASE_IN_OUT)
  .easingY(EASE_IN_OUT)
  .reduceMotion(ReduceMotion.System);
const PINNED_ENTER = FadeIn.duration(180).easing(EASE_OUT).reduceMotion(ReduceMotion.System);
const PINNED_EXIT = FadeOut.duration(140).easing(EASE_OUT).reduceMotion(ReduceMotion.System);

export function PinnedBotsStrip({ bots }: { bots: MobileBot[] }) {
  return (
    <Animated.View layout={PINNED_LAYOUT}>
      {bots.length > 0 ? (
        <Animated.View exiting={PINNED_EXIT} style={{ width: "100%" }}>
          <ScrollView
            horizontal
            alwaysBounceHorizontal={false}
            contentContainerStyle={{
              alignItems: "flex-start",
              flexGrow: 1,
              gap: 18,
              justifyContent: "center",
              paddingHorizontal: 20,
              paddingVertical: 22,
            }}
            showsHorizontalScrollIndicator={false}
          >
            {bots.map((bot) => (
              <PinnedBotItem key={bot.id} bot={bot} />
            ))}
          </ScrollView>
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

function PinnedBotItem({ bot }: { bot: MobileBot }) {
  const [background, accent] = useThemeColor(["background", "accent"]);
  const { unreadBotIds } = useMobileWorkspace();
  const botContextMenu = useBotContextMenu(bot);
  const isUnread = unreadBotIds.includes(bot.id);

  const handleOpen = () => {
    if (isIOS) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft);
  };

  return (
    <Animated.View entering={PINNED_ENTER} exiting={PINNED_EXIT} layout={PINNED_ITEM_LAYOUT}>
      <Link href={{ pathname: "/chat/[botId]", params: { botId: bot.id } }} asChild onPress={handleOpen}>
        <Link.Trigger>
          <Pressable
            accessibilityLabel={`Open pinned chat with ${bot.name}`}
            accessibilityRole="button"
            className="w-20 items-center gap-2"
            style={({ pressed }) => ({ opacity: pressed ? 0.58 : 1 })}
          >
            <Link.AppleZoom>
              <BotPinAvatar botId={bot.id} location="pinned" size={76}>
                <BloubAvatar botId={bot.id} hue={bot.avatarHue} seed={bot.avatarSeed} size={76} />
                {isUnread ? (
                  <View
                    className="absolute right-0 top-0 size-3.5 rounded-full border-2 bg-accent"
                    style={{ borderColor: background, backgroundColor: accent }}
                  />
                ) : null}
              </BotPinAvatar>
            </Link.AppleZoom>
            <Typography.Paragraph
              type="body-xs"
              align="center"
              className="w-full text-text-secondary"
              numberOfLines={1}
            >
              {bot.name}
            </Typography.Paragraph>
          </Pressable>
        </Link.Trigger>
        {botContextMenu}
      </Link>
    </Animated.View>
  );
}
