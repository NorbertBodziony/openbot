import MaskedView from "@react-native-masked-view/masked-view";
import { BlurView } from "expo-blur";
import * as Haptics from "expo-haptics";
import { Link } from "expo-router";
import { Typography } from "heroui-native";
import { useThemeColor } from "heroui-native/hooks";
import { Pin } from "lucide-react-native";
import { type PropsWithChildren, useEffect, useId, useRef } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import ReanimatedSwipeable, { type SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import Animated, {
  Easing,
  interpolate,
  ReduceMotion,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";

import { BloubAvatar } from "@/features/bots/components/bloub-avatar";
import { useBotContextMenu } from "@/features/bots/components/bot-context-menu";
import { BotPinAvatar } from "@/features/bots/components/bot-pin-avatar";
import { type BotAvatarLocation, useBotPinTransition } from "@/features/bots/components/bot-pin-transition";
import { type MobileBot, useMobileWorkspace } from "@/features/workspace/context/mobile-workspace-context";
import { isIOS } from "@/shared/lib/platform";

const AnimatedRect = Animated.createAnimatedComponent(Rect);
const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);

function BotRowTextReveal({ active, children }: PropsWithChildren<{ active: boolean }>) {
  const gradientId = `bot-row-reveal-${useId().replaceAll(":", "")}`;
  const width = useSharedValue(0);
  const progress = useSharedValue(active ? 0 : 1);

  useEffect(() => {
    progress.set(
      active ? withDelay(45, withTiming(1, { duration: 220, easing: EASE_OUT, reduceMotion: ReduceMotion.System })) : 1,
    );
  }, [active, progress]);

  const contentStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.get(), [0, 0.35, 1], [0, 0.78, 1]),
  }));
  const blurStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.get(), [0, 0.35, 0.8, 1], [0.72, 0.58, 0.1, 0]),
  }));
  const maskProps = useAnimatedProps(() => ({ width: width.get() * progress.get() }));

  if (!active) return children;

  return (
    <Animated.View
      className="min-w-0 flex-1"
      onLayout={(event) => width.set(event.nativeEvent.layout.width)}
      style={contentStyle}
    >
      <MaskedView
        style={{ width: "100%" }}
        maskElement={
          <Svg height="100%" width="100%">
            <Defs>
              <LinearGradient id={gradientId} x1="0" x2="1" y1="0" y2="0">
                <Stop offset="0" stopColor="#000" stopOpacity="1" />
                <Stop offset="0.82" stopColor="#000" stopOpacity="1" />
                <Stop offset="1" stopColor="#000" stopOpacity="0" />
              </LinearGradient>
            </Defs>
            <AnimatedRect animatedProps={maskProps} fill={`url(#${gradientId})`} height="100%" x="0" y="0" />
          </Svg>
        }
      >
        {children}
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, blurStyle]}>
          <BlurView intensity={16} style={StyleSheet.absoluteFill} tint="systemUltraThinMaterial" />
        </Animated.View>
      </MaskedView>
    </Animated.View>
  );
}

interface BotListRowProps {
  avatarLocation?: BotAvatarLocation;
  bot: MobileBot;
  dismissToChat?: boolean;
  enableActions?: boolean;
  enableZoomTransition?: boolean;
  horizontalInset?: number;
}

export function BotListRow({
  avatarLocation = "row",
  bot,
  dismissToChat = false,
  enableActions = true,
  enableZoomTransition = true,
  horizontalInset = 20,
}: BotListRowProps) {
  const [background, accent, accentForeground] = useThemeColor(["background", "accent", "accent-foreground"]);
  const { markBotRead, unreadBotIds } = useMobileWorkspace();
  const { startBotNavigationAnimated, toggleBotPinAnimated, transition } = useBotPinTransition();
  const pendingPinRef = useRef(false);
  const botContextMenu = useBotContextMenu(bot);
  const isUnread = unreadBotIds.includes(bot.id);
  const isUnpinTarget = transition?.botId === bot.id && transition.target === "row";
  const avatar = (
    <BotPinAvatar botId={bot.id} location={avatarLocation} size={54}>
      <BloubAvatar seed={bot.avatarSeed} size={54} />
    </BotPinAvatar>
  );

  const handleOpen = () => {
    markBotRead(bot.id);
    if (dismissToChat) startBotNavigationAnimated(bot.id, avatarLocation);
    if (isIOS) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft);
  };

  const linkTrigger = (
    <Link.Trigger>
      <Pressable accessibilityLabel={`Open chat with ${bot.name}`} accessibilityRole="button" className="w-full">
        {({ pressed }) => (
          <View
            className="min-h-20 w-full flex-row items-center gap-3 py-3"
            style={{ backgroundColor: background, opacity: pressed ? 0.58 : 1, paddingHorizontal: horizontalInset }}
          >
            {enableZoomTransition ? <Link.AppleZoom>{avatar}</Link.AppleZoom> : avatar}
            <BotRowTextReveal active={isUnpinTarget}>
              <View className="min-w-0 flex-1 gap-1">
                <View className="flex-row items-center gap-2">
                  {isUnread ? <View className="size-2 rounded-full bg-accent" /> : null}
                  <Typography.Paragraph className="min-w-0 flex-1" weight="semibold" numberOfLines={1}>
                    {bot.name}
                  </Typography.Paragraph>
                  <Typography.Paragraph type="body-xs" className="text-text-dim">
                    {bot.updatedLabel}
                  </Typography.Paragraph>
                </View>
                <Typography.Paragraph type="body-xs" className="text-text-secondary" numberOfLines={1}>
                  {bot.preview}
                </Typography.Paragraph>
              </View>
            </BotRowTextReveal>
          </View>
        )}
      </Pressable>
    </Link.Trigger>
  );

  const href = {
    pathname: "/chat/[botId]" as const,
    params: dismissToChat ? { avatarTransition: "search", botId: bot.id } : { botId: bot.id },
  };
  const botLink = enableActions ? (
    <Link href={href} asChild dismissTo={dismissToChat} onPress={handleOpen}>
      {linkTrigger}
      {botContextMenu}
    </Link>
  ) : (
    <Link href={href} asChild dismissTo={dismissToChat} onPress={handleOpen}>
      {linkTrigger}
    </Link>
  );

  if (!enableActions) return botLink;

  const handlePin = (swipeable: SwipeableMethods) => {
    pendingPinRef.current = true;
    swipeable.close();
  };

  const handleSwipeableClose = () => {
    if (!pendingPinRef.current) return;
    pendingPinRef.current = false;
    toggleBotPinAnimated(bot.id);
  };

  return (
    <ReanimatedSwipeable
      childrenContainerStyle={{ backgroundColor: background }}
      containerStyle={{ backgroundColor: background, overflow: "hidden" }}
      enableTrackpadTwoFingerGesture
      onSwipeableClose={handleSwipeableClose}
      overshootFriction={8}
      overshootRight={false}
      renderRightActions={(_progress, _translation, swipeable) => (
        <View className="w-[88px] overflow-hidden" style={{ backgroundColor: accent }}>
          <Pressable
            accessibilityLabel={`Pin ${bot.name}`}
            accessibilityRole="button"
            className="flex-1 items-center justify-center gap-1.5"
            style={({ pressed }) => ({ backgroundColor: accent, opacity: pressed ? 0.72 : 1 })}
            onPress={() => handlePin(swipeable)}
          >
            <Pin color={String(accentForeground)} fill={String(accentForeground)} size={22} strokeWidth={1.8} />
            <Typography.Paragraph type="body-xs" weight="semibold" style={{ color: accentForeground }}>
              Pin
            </Typography.Paragraph>
          </Pressable>
        </View>
      )}
      rightThreshold={42}
    >
      {botLink}
    </ReanimatedSwipeable>
  );
}
