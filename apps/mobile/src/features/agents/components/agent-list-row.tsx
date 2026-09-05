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
import { useAgentContextMenu } from "@/features/agents/components/agent-context-menu";
import { AgentPinAvatar } from "@/features/agents/components/agent-pin-avatar";
import { type AgentAvatarLocation, useAgentPinTransition } from "@/features/agents/components/agent-pin-transition";
import { BloubAvatar } from "@/features/agents/components/bloub-avatar";
import { type MobileAgent, useMobileWorkspace } from "@/features/workspace/context/mobile-workspace-context";
import { isIOS } from "@/shared/lib/platform";

const AnimatedRect = Animated.createAnimatedComponent(Rect);
const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);

function AgentRowTextReveal({ active, children }: PropsWithChildren<{ active: boolean }>) {
  const gradientId = `agent-row-reveal-${useId().replaceAll(":", "")}`;
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

interface AgentListRowProps {
  avatarLocation?: AgentAvatarLocation;
  agent: MobileAgent;
  dismissToChat?: boolean;
  enableActions?: boolean;
  enableZoomTransition?: boolean;
  leftInset?: number;
  rightInset?: number;
}

export function AgentListRow({
  avatarLocation = "row",
  agent,
  dismissToChat = false,
  enableActions = true,
  enableZoomTransition = true,
  leftInset = 20,
  rightInset = 20,
}: AgentListRowProps) {
  const [background, accent, accentForeground] = useThemeColor(["background", "accent", "accent-foreground"]);
  const { unreadAgentIds } = useMobileWorkspace();
  const { startAgentNavigationAnimated, toggleAgentPinAnimated, transition } = useAgentPinTransition();
  const pendingPinRef = useRef(false);
  const agentContextMenu = useAgentContextMenu(agent);
  const isUnread = unreadAgentIds.includes(agent.id);
  const isUnpinTarget = transition?.agentId === agent.id && transition.target === "row";
  const avatar = (
    <AgentPinAvatar agentId={agent.id} location={avatarLocation} size={54}>
      <BloubAvatar hue={agent.avatarHue} seed={agent.avatarSeed} size={54} />
    </AgentPinAvatar>
  );

  const handleOpen = () => {
    if (dismissToChat) startAgentNavigationAnimated(agent.id, avatarLocation);
    if (isIOS) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft);
  };

  const linkTrigger = (
    <Link.Trigger>
      <Pressable accessibilityLabel={`Open chat with ${agent.name}`} accessibilityRole="button" className="w-full">
        {({ pressed }) => (
          <View
            className="min-h-20 w-full flex-row items-center gap-3 py-3"
            style={{
              backgroundColor: background,
              opacity: pressed ? 0.58 : 1,
              paddingLeft: leftInset,
              paddingRight: rightInset,
            }}
          >
            {enableZoomTransition ? <Link.AppleZoom>{avatar}</Link.AppleZoom> : avatar}
            <AgentRowTextReveal active={isUnpinTarget}>
              <View className="min-w-0 flex-1 gap-1">
                <View className="flex-row items-center gap-2">
                  {isUnread ? <View className="size-2 rounded-full bg-accent" /> : null}
                  <Typography.Paragraph className="min-w-0 flex-1" weight="semibold" numberOfLines={1}>
                    {agent.name}
                  </Typography.Paragraph>
                  <Typography.Paragraph type="body-xs" className="text-text-dim">
                    {agent.updatedLabel}
                  </Typography.Paragraph>
                </View>
                <Typography.Paragraph type="body-xs" className="text-text-secondary" numberOfLines={1}>
                  {agent.preview}
                </Typography.Paragraph>
              </View>
            </AgentRowTextReveal>
          </View>
        )}
      </Pressable>
    </Link.Trigger>
  );

  const href = {
    pathname: "/chat/[agentId]" as const,
    params: dismissToChat ? { avatarTransition: "search", agentId: agent.id } : { agentId: agent.id },
  };
  const agentLink = enableActions ? (
    <Link href={href} asChild dismissTo={dismissToChat} onPress={handleOpen}>
      {linkTrigger}
      {agentContextMenu}
    </Link>
  ) : (
    <Link href={href} asChild dismissTo={dismissToChat} onPress={handleOpen}>
      {linkTrigger}
    </Link>
  );

  if (!enableActions) return agentLink;

  const handlePin = (swipeable: SwipeableMethods) => {
    pendingPinRef.current = true;
    swipeable.close();
  };

  const handleSwipeableClose = () => {
    if (!pendingPinRef.current) return;
    pendingPinRef.current = false;
    toggleAgentPinAnimated(agent.id);
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
            accessibilityLabel={`Pin ${agent.name}`}
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
      {agentLink}
    </ReanimatedSwipeable>
  );
}
