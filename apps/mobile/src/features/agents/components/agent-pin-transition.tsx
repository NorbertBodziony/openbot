import type { AvatarHue } from "@openbot/contracts/ipc";
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
import { Easing, ReduceMotion, useSharedValue, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

import { AgentPinTransitionOverlay } from "@/features/agents/components/agent-pin-transition-overlay";
import { MAX_PINNED_AGENTS, useMobileWorkspace } from "@/features/workspace/context/mobile-workspace-context";
import { isIOS } from "@/shared/lib/platform";

export type AgentAvatarLocation = "chat" | "pinned" | "row" | "search";

interface AvatarRect {
  height: number;
  width: number;
  x: number;
  y: number;
}

export interface AgentPinTransitionState {
  agentId: string;
  avatarHue: AvatarHue | null;
  avatarSeed: string;
  from: AvatarRect;
  source: AgentAvatarLocation;
  target: AgentAvatarLocation;
  to?: AvatarRect;
}

interface AgentPinTransitionContextValue {
  leaveAgentChatAnimated: (agentId: string) => void;
  registerAvatar: (agentId: string, location: AgentAvatarLocation, node: View | null) => void;
  notifyAvatarLayout: (agentId: string, location: AgentAvatarLocation) => void;
  startAgentNavigationAnimated: (agentId: string, source: AgentAvatarLocation) => void;
  toggleAgentPinAnimated: (agentId: string) => void;
  transition: AgentPinTransitionState | null;
}

const AgentPinTransitionContext = createContext<AgentPinTransitionContextValue | null>(null);
const EASE_IN_OUT = Easing.bezier(0.77, 0, 0.175, 1);
const TRANSITION_DURATION = 320;

export function AgentPinTransitionProvider({ children }: PropsWithChildren) {
  const { agents, pinnedAgentIds, toggleAgentPin } = useMobileWorkspace();
  const containerRef = useRef<View>(null);
  const avatarRefs = useRef(new Map<string, Partial<Record<AgentAvatarLocation, View>>>()).current;
  const avatarRects = useRef(new Map<string, Partial<Record<AgentAvatarLocation, AvatarRect>>>()).current;
  const transitionRef = useRef<AgentPinTransitionState | null>(null);
  const animationStartedRef = useRef(false);
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [transition, setTransition] = useState<AgentPinTransitionState | null>(null);
  const progress = useSharedValue(0);

  const finishTransition = useCallback(() => {
    if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current);
    fallbackTimerRef.current = null;
    animationStartedRef.current = false;
    transitionRef.current = null;
    setTransition(null);
  }, []);

  const startMovement = useCallback(
    (nextTransition: AgentPinTransitionState) => {
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
    (agentId: string, location: AgentAvatarLocation) => {
      const node = avatarRefs.get(agentId)?.[location];
      const container = containerRef.current;
      if (!node || !container) return;

      container.measureInWindow((containerX, containerY) => {
        node.measureInWindow((x, y, width, height) => {
          const rect = { x: x - containerX, y: y - containerY, width, height };
          const rects = avatarRects.get(agentId) ?? {};
          rects[location] = rect;
          avatarRects.set(agentId, rects);

          const latest = transitionRef.current;
          if (!latest || latest.agentId !== agentId || latest.target !== location || latest.to) return;

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
    (agentId: string, location: AgentAvatarLocation, node: View | null) => {
      const refs = avatarRefs.get(agentId) ?? {};
      if (node) {
        refs[location] = node;
        avatarRefs.set(agentId, refs);
        requestAnimationFrame(() => measureAvatar(agentId, location));
      } else {
        delete refs[location];
        if (Object.keys(refs).length === 0) avatarRefs.delete(agentId);
      }
    },
    [avatarRefs, measureAvatar],
  );

  const notifyAvatarLayout = useCallback(
    (agentId: string, location: AgentAvatarLocation) => {
      requestAnimationFrame(() => measureAvatar(agentId, location));
    },
    [measureAvatar],
  );

  const startAgentNavigationAnimated = useCallback(
    (agentId: string, source: AgentAvatarLocation) => {
      const agent = agents.find((item) => item.id === agentId);
      const from = avatarRects.get(agentId)?.[source];
      if (!agent || !from || transitionRef.current) return;

      const nextTransition: AgentPinTransitionState = {
        agentId,
        avatarHue: agent.avatarHue,
        avatarSeed: agent.avatarSeed,
        from,
        source,
        target: "chat",
      };
      transitionRef.current = nextTransition;
      setTransition(nextTransition);
      progress.set(0);
      fallbackTimerRef.current = setTimeout(finishTransition, 1200);
    },
    [avatarRects, agents, finishTransition, progress],
  );

  const leaveAgentChatAnimated = useCallback(
    (agentId: string) => {
      const navigateBack = () => {
        if (router.canGoBack()) router.back();
        else router.replace("/connected");
      };
      const agent = agents.find((item) => item.id === agentId);
      const from = avatarRects.get(agentId)?.chat;

      if (!agent || !from || transitionRef.current) {
        navigateBack();
        return;
      }

      const target: AgentAvatarLocation = pinnedAgentIds.includes(agentId) ? "pinned" : "row";
      const to = avatarRects.get(agentId)?.[target];
      const nextTransition: AgentPinTransitionState = {
        agentId,
        avatarHue: agent.avatarHue,
        avatarSeed: agent.avatarSeed,
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
    [avatarRects, agents, finishTransition, pinnedAgentIds, progress, startMovement],
  );

  const toggleAgentPinAnimated = useCallback(
    (agentId: string) => {
      const agent = agents.find((item) => item.id === agentId);
      if (!agent || transitionRef.current) return;

      const isPinned = pinnedAgentIds.includes(agentId);
      const pinnedOnServer = pinnedAgentIds.filter((id) =>
        agents.some((item) => item.id === id && item.serverId === agent.serverId),
      );
      if (!isPinned && pinnedOnServer.length >= MAX_PINNED_AGENTS) {
        if (isIOS) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        Alert.alert("Pin limit reached", `You can pin up to ${MAX_PINNED_AGENTS} agents on a server.`);
        return;
      }

      const source: AgentAvatarLocation = isPinned ? "pinned" : "row";
      const target: AgentAvatarLocation = isPinned ? "row" : "pinned";
      const sourceNode = avatarRefs.get(agentId)?.[source];
      const container = containerRef.current;

      const commitWithoutMovement = () => {
        toggleAgentPin(agentId);
        if (isIOS) void Haptics.selectionAsync();
      };

      if (!sourceNode || !container) {
        commitWithoutMovement();
        return;
      }

      container.measureInWindow((containerX, containerY) => {
        sourceNode.measureInWindow((x, y, width, height) => {
          const nextTransition: AgentPinTransitionState = {
            agentId,
            avatarHue: agent.avatarHue,
            avatarSeed: agent.avatarSeed,
            from: { x: x - containerX, y: y - containerY, width, height },
            source,
            target,
          };
          transitionRef.current = nextTransition;
          setTransition(nextTransition);
          progress.set(0);

          requestAnimationFrame(() => {
            const result = toggleAgentPin(agentId);
            if (result === "limit") {
              finishTransition();
              Alert.alert("Pin limit reached", `You can pin up to ${MAX_PINNED_AGENTS} agents on a server.`);
              return;
            }
            if (isIOS) void Haptics.selectionAsync();
            fallbackTimerRef.current = setTimeout(finishTransition, 700);
          });
        });
      });
    },
    [avatarRefs, agents, finishTransition, pinnedAgentIds, progress, toggleAgentPin],
  );

  useEffect(
    () => () => {
      if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current);
    },
    [],
  );

  const contextValue = useMemo<AgentPinTransitionContextValue>(
    () => ({
      leaveAgentChatAnimated,
      registerAvatar,
      notifyAvatarLayout,
      startAgentNavigationAnimated,
      toggleAgentPinAnimated,
      transition,
    }),
    [
      leaveAgentChatAnimated,
      notifyAvatarLayout,
      registerAvatar,
      startAgentNavigationAnimated,
      toggleAgentPinAnimated,
      transition,
    ],
  );

  return (
    <AgentPinTransitionContext.Provider value={contextValue}>
      <View ref={containerRef} collapsable={false} style={{ flex: 1 }}>
        {children}
        <AgentPinTransitionOverlay progress={progress} transition={transition} />
      </View>
    </AgentPinTransitionContext.Provider>
  );
}

export function useAgentPinTransition(): AgentPinTransitionContextValue {
  const context = useContext(AgentPinTransitionContext);
  const { toggleAgentPin } = useMobileWorkspace();

  return useMemo(
    () =>
      context ?? {
        leaveAgentChatAnimated: () => {
          if (router.canGoBack()) router.back();
          else router.replace("/connected");
        },
        notifyAvatarLayout: () => undefined,
        registerAvatar: () => undefined,
        startAgentNavigationAnimated: () => undefined,
        toggleAgentPinAnimated: (agentId: string) => {
          const result = toggleAgentPin(agentId);
          if (result === "limit") {
            Alert.alert("Pin limit reached", `You can pin up to ${MAX_PINNED_AGENTS} agents on a server.`);
          }
        },
        transition: null,
      },
    [context, toggleAgentPin],
  );
}
