import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Alert, View } from "react-native";
import Animated, {
  Easing,
  interpolate,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

import { BloubAvatar } from "@/components/bloub-avatar";
import { isIOS } from "@/lib/platform";
import { MAX_PINNED_BOTS, useMobileWorkspace } from "@/providers/mobile-workspace-provider";

export type BotAvatarLocation = "chat" | "pinned" | "row" | "search";

interface AvatarRect {
  height: number;
  width: number;
  x: number;
  y: number;
}

export interface BotPinTransitionState {
  botId: string;
  avatarSeed: string;
  from: AvatarRect;
  source: BotAvatarLocation;
  target: BotAvatarLocation;
  to?: AvatarRect;
}

interface BotPinTransitionContextValue {
  leaveBotChatAnimated: (botId: string) => void;
  registerAvatar: (botId: string, location: BotAvatarLocation, node: View | null) => void;
  notifyAvatarLayout: (botId: string, location: BotAvatarLocation) => void;
  startBotNavigationAnimated: (botId: string, source: BotAvatarLocation) => void;
  toggleBotPinAnimated: (botId: string) => void;
  transition: BotPinTransitionState | null;
}

const BotPinTransitionContext = createContext<BotPinTransitionContextValue | null>(null);
const EASE_IN_OUT = Easing.bezier(0.77, 0, 0.175, 1);
const TRANSITION_DURATION = 320;

export function BotPinTransitionProvider({ children }: PropsWithChildren) {
  const { bots, pinnedBotIds, toggleBotPin } = useMobileWorkspace();
  const containerRef = useRef<View>(null);
  const avatarRefs = useRef(new Map<string, Partial<Record<BotAvatarLocation, View>>>()).current;
  const avatarRects = useRef(new Map<string, Partial<Record<BotAvatarLocation, AvatarRect>>>()).current;
  const transitionRef = useRef<BotPinTransitionState | null>(null);
  const animationStartedRef = useRef(false);
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [transition, setTransition] = useState<BotPinTransitionState | null>(null);
  const progress = useSharedValue(0);

  const finishTransition = useCallback(() => {
    if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current);
    fallbackTimerRef.current = null;
    animationStartedRef.current = false;
    transitionRef.current = null;
    setTransition(null);
  }, []);

  const startMovement = useCallback(
    (nextTransition: BotPinTransitionState) => {
      if (animationStartedRef.current) return;
      animationStartedRef.current = true;
      transitionRef.current = nextTransition;
      setTransition(nextTransition);
      progress.set(0);
      progress.set(
        withTiming(
          1,
          {
            duration: TRANSITION_DURATION,
            easing: EASE_IN_OUT,
            reduceMotion: ReduceMotion.System,
          },
          (finished) => {
            "worklet";
            if (finished) scheduleOnRN(finishTransition);
          },
        ),
      );
    },
    [finishTransition, progress],
  );

  const measureAvatar = useCallback(
    (botId: string, location: BotAvatarLocation) => {
      const node = avatarRefs.get(botId)?.[location];
      const container = containerRef.current;
      if (!node || !container) return;

      container.measureInWindow((containerX, containerY) => {
        node.measureInWindow((x, y, width, height) => {
          const rect = { x: x - containerX, y: y - containerY, width, height };
          const rects = avatarRects.get(botId) ?? {};
          rects[location] = rect;
          avatarRects.set(botId, rects);

          const latest = transitionRef.current;
          if (!latest || latest.botId !== botId || latest.target !== location || latest.to) return;

          const nextTransition = {
            ...latest,
            to: rect,
          };
          startMovement(nextTransition);
        });
      });
    },
    [avatarRects, avatarRefs, startMovement],
  );

  const registerAvatar = useCallback(
    (botId: string, location: BotAvatarLocation, node: View | null) => {
      const refs = avatarRefs.get(botId) ?? {};
      if (node) {
        refs[location] = node;
        avatarRefs.set(botId, refs);
        requestAnimationFrame(() => measureAvatar(botId, location));
      } else {
        delete refs[location];
        if (Object.keys(refs).length === 0) avatarRefs.delete(botId);
      }
    },
    [avatarRefs, measureAvatar],
  );

  const notifyAvatarLayout = useCallback(
    (botId: string, location: BotAvatarLocation) => {
      requestAnimationFrame(() => measureAvatar(botId, location));
    },
    [measureAvatar],
  );

  const startBotNavigationAnimated = useCallback(
    (botId: string, source: BotAvatarLocation) => {
      const bot = bots.find((item) => item.id === botId);
      const from = avatarRects.get(botId)?.[source];
      if (!bot || !from || transitionRef.current) return;

      const nextTransition: BotPinTransitionState = {
        botId,
        avatarSeed: bot.avatarSeed,
        from,
        source,
        target: "chat",
      };
      transitionRef.current = nextTransition;
      setTransition(nextTransition);
      progress.set(0);
      fallbackTimerRef.current = setTimeout(finishTransition, 1200);
    },
    [avatarRects, bots, finishTransition, progress],
  );

  const leaveBotChatAnimated = useCallback(
    (botId: string) => {
      const navigateBack = () => {
        if (router.canGoBack()) router.back();
        else router.replace("/connected");
      };
      const bot = bots.find((item) => item.id === botId);
      const from = avatarRects.get(botId)?.chat;

      if (!bot || !from || transitionRef.current) {
        navigateBack();
        return;
      }

      const target: BotAvatarLocation = pinnedBotIds.includes(botId) ? "pinned" : "row";
      const to = avatarRects.get(botId)?.[target];
      const nextTransition: BotPinTransitionState = {
        botId,
        avatarSeed: bot.avatarSeed,
        from,
        source: "chat",
        target,
        ...(to ? { to } : {}),
      };

      transitionRef.current = nextTransition;
      setTransition(nextTransition);
      progress.set(0);
      fallbackTimerRef.current = setTimeout(finishTransition, 1200);

      requestAnimationFrame(() => {
        navigateBack();
        if (to) startMovement(nextTransition);
      });
    },
    [avatarRects, bots, finishTransition, pinnedBotIds, progress, startMovement],
  );

  const toggleBotPinAnimated = useCallback(
    (botId: string) => {
      const bot = bots.find((item) => item.id === botId);
      if (!bot || transitionRef.current) return;

      const isPinned = pinnedBotIds.includes(botId);
      const pinnedOnServer = pinnedBotIds.filter((id) =>
        bots.some((item) => item.id === id && item.serverId === bot.serverId),
      );
      if (!isPinned && pinnedOnServer.length >= MAX_PINNED_BOTS) {
        if (isIOS) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        Alert.alert("Pin limit reached", `You can pin up to ${MAX_PINNED_BOTS} bots on a server.`);
        return;
      }

      const source: BotAvatarLocation = isPinned ? "pinned" : "row";
      const target: BotAvatarLocation = isPinned ? "row" : "pinned";
      const sourceNode = avatarRefs.get(botId)?.[source];
      const container = containerRef.current;

      const commitWithoutMovement = () => {
        toggleBotPin(botId);
        if (isIOS) void Haptics.selectionAsync();
      };

      if (!sourceNode || !container) {
        commitWithoutMovement();
        return;
      }

      container.measureInWindow((containerX, containerY) => {
        sourceNode.measureInWindow((x, y, width, height) => {
          const nextTransition: BotPinTransitionState = {
            botId,
            avatarSeed: bot.avatarSeed,
            from: { x: x - containerX, y: y - containerY, width, height },
            source,
            target,
          };
          transitionRef.current = nextTransition;
          setTransition(nextTransition);
          progress.set(0);

          requestAnimationFrame(() => {
            const result = toggleBotPin(botId);
            if (result === "limit") {
              finishTransition();
              Alert.alert("Pin limit reached", `You can pin up to ${MAX_PINNED_BOTS} bots on a server.`);
              return;
            }
            if (isIOS) void Haptics.selectionAsync();
            fallbackTimerRef.current = setTimeout(finishTransition, 700);
          });
        });
      });
    },
    [avatarRefs, bots, finishTransition, pinnedBotIds, progress, toggleBotPin],
  );

  useEffect(
    () => () => {
      if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current);
    },
    [],
  );

  const contextValue = useMemo<BotPinTransitionContextValue>(
    () => ({
      leaveBotChatAnimated,
      registerAvatar,
      notifyAvatarLayout,
      startBotNavigationAnimated,
      toggleBotPinAnimated,
      transition,
    }),
    [
      leaveBotChatAnimated,
      notifyAvatarLayout,
      registerAvatar,
      startBotNavigationAnimated,
      toggleBotPinAnimated,
      transition,
    ],
  );

  const overlayStyle = useAnimatedStyle(() => {
    if (!transition) return { opacity: 0 };

    const to = transition.to ?? transition.from;
    const value = progress.get();
    const scale = interpolate(value, [0, 1], [1, to.width / transition.from.width]);
    const endX = to.x - transition.from.x + (to.width - transition.from.width) / 2;
    const endY = to.y - transition.from.y + (to.height - transition.from.height) / 2;
    const arc = -24 * 4 * value * (1 - value);

    return {
      height: transition.from.height,
      left: transition.from.x,
      opacity: transition.to ? 1 : 0.98,
      position: "absolute",
      top: transition.from.y,
      transform: [{ translateX: endX * value }, { translateY: endY * value + arc }, { scale }],
      width: transition.from.width,
      zIndex: 100,
    };
  }, [transition]);

  return (
    <BotPinTransitionContext.Provider value={contextValue}>
      <View ref={containerRef} collapsable={false} style={{ flex: 1 }}>
        {children}
        {transition ? (
          <Animated.View pointerEvents="none" style={overlayStyle}>
            <BloubAvatar seed={transition.avatarSeed} size={transition.from.width} />
          </Animated.View>
        ) : null}
      </View>
    </BotPinTransitionContext.Provider>
  );
}

export function BotPinAvatar({
  botId,
  children,
  location,
  size,
}: PropsWithChildren<{ botId: string; location: BotAvatarLocation; size: number }>) {
  const ref = useRef<View>(null);
  const { notifyAvatarLayout, registerAvatar, transition } = useBotPinTransition();

  useEffect(() => {
    registerAvatar(botId, location, ref.current);
    return () => registerAvatar(botId, location, null);
  }, [botId, location, registerAvatar]);

  const hidden = transition?.botId === botId && (transition.source === location || transition.target === location);

  return (
    <View
      ref={ref}
      collapsable={false}
      onLayout={() => notifyAvatarLayout(botId, location)}
      style={{ height: size, opacity: hidden ? 0 : 1, width: size }}
    >
      {children}
    </View>
  );
}

export function useBotPinTransition(): BotPinTransitionContextValue {
  const context = useContext(BotPinTransitionContext);
  const { toggleBotPin } = useMobileWorkspace();

  return useMemo(
    () =>
      context ?? {
        leaveBotChatAnimated: () => {
          if (router.canGoBack()) router.back();
          else router.replace("/connected");
        },
        notifyAvatarLayout: () => undefined,
        registerAvatar: () => undefined,
        startBotNavigationAnimated: () => undefined,
        toggleBotPinAnimated: (botId: string) => {
          const result = toggleBotPin(botId);
          if (result === "limit") {
            Alert.alert("Pin limit reached", `You can pin up to ${MAX_PINNED_BOTS} bots on a server.`);
          }
        },
        transition: null,
      },
    [context, toggleBotPin],
  );
}
