import { isLiquidGlassAvailable } from "expo-glass-effect";
import * as Haptics from "expo-haptics";
import { router, useIsFocused } from "expo-router";
import { useThemeColor } from "heroui-native/hooks";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  KeyboardAvoidingView,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollView,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";

import { useAgentPinTransition } from "@/features/agents/components/agent-pin-transition";
import { ChatComposer } from "@/features/chat/components/chat-composer";
import { ChatHeader } from "@/features/chat/components/chat-header";
import { type ChatMessage, ChatMessageList } from "@/features/chat/components/chat-message-list";
import { ConnectionStatus } from "@/features/workspace/components/connection-status";
import type { MobileAgent } from "@/features/workspace/context/mobile-workspace-context";
import { useMobileWorkspace } from "@/features/workspace/context/mobile-workspace-context";
import { isIOS } from "@/shared/lib/platform";

interface MobileChatViewProps {
  animateAvatarOnExit?: boolean;
  agent: MobileAgent;
}

const CHAT_BACK_EDGE_WIDTH = 24;

function leaveConversation(): void {
  if (router.canGoBack()) router.back();
  else router.replace("/connected");
}

export function MobileChatView({ animateAvatarOnExit = false, agent }: MobileChatViewProps) {
  const isFocused = useIsFocused();
  const [appActive, setAppActive] = useState(AppState.currentState === "active");
  const [atLatest, setAtLatest] = useState(false);
  const insets = useSafeAreaInsets();
  const { leaveAgentChatAnimated } = useAgentPinTransition();
  const scrollViewRef = useRef<ScrollView>(null);
  const initialScrollAgentIdRef = useRef<string | null>(agent.id);
  const [foreground, muted, fieldBackground, raised, action, actionForeground, background] = useThemeColor([
    "foreground",
    "muted",
    "default",
    "surface-tertiary",
    "accent",
    "accent-foreground",
    "background",
  ]);
  const [draft, setDraft] = useState("");
  const [showStarter, setShowStarter] = useState(true);
  const {
    conversations,
    loadConversation,
    markAgentRead,
    servers,
    sendMessage: sendTeamMessage,
  } = useMobileWorkspace();
  const conversation = conversations[agent.id];
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  const messages = useMemo<ChatMessage[]>(
    () =>
      (conversation?.messages ?? [])
        .filter((message) => message.text.trim().length > 0 && message.author !== "system")
        .map((message) => ({
          id: message.id,
          author: message.author === "user" ? "user" : "agent",
          body: message.text,
        })),
    [conversation],
  );
  const liquidGlassAvailable = isLiquidGlassAvailable();
  const latestMessage = conversation?.messages.findLast(
    (message) => message.author !== "system" && message.text.trim().length > 0,
  );
  const readBoundary = latestMessage?.id;
  const readBoundaryStatus = latestMessage?.status;
  const serverOnline = servers.find((server) => server.id === agent.serverId)?.state === "online";

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => setAppActive(state === "active"));
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (isFocused && appActive && atLatest && serverOnline && readBoundary && readBoundaryStatus) {
      markAgentRead(agent.id, readBoundary);
    }
  }, [isFocused, appActive, atLatest, serverOnline, readBoundary, readBoundaryStatus, agent.id, markAgentRead]);

  useEffect(() => {
    let active = true;
    const revisionBeforeLoad = conversationRef.current?.revision ?? null;
    setAtLatest(false);
    initialScrollAgentIdRef.current = agent.id;
    void loadConversation(agent.id)
      .then((snapshot) => {
        if (active && (revisionBeforeLoad === null || snapshot.revision > revisionBeforeLoad)) {
          initialScrollAgentIdRef.current = agent.id;
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [agent.id, loadConversation]);

  const handleContentSizeChange = useCallback(() => {
    if (!conversation || (initialScrollAgentIdRef.current !== agent.id && !atLatest)) return;
    initialScrollAgentIdRef.current = null;
    scrollViewRef.current?.scrollToEnd({ animated: false });
    setAtLatest(true);
  }, [atLatest, agent.id, conversation]);

  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    setAtLatest(contentOffset.y + layoutMeasurement.height >= contentSize.height - 24);
  }, []);

  const handleLeaveConversation = useCallback(() => {
    if (animateAvatarOnExit) leaveAgentChatAnimated(agent.id);
    else leaveConversation();
  }, [animateAvatarOnExit, agent.id, leaveAgentChatAnimated]);

  const edgeBackGesture = useMemo(
    () =>
      Gesture.Pan()
        .hitSlop({ left: 0, width: CHAT_BACK_EDGE_WIDTH })
        .activeOffsetX(12)
        .failOffsetX(-8)
        .failOffsetY([-16, 16])
        .onEnd((event) => {
          if (event.translationX >= 48 || event.velocityX >= 650) scheduleOnRN(handleLeaveConversation);
        }),
    [handleLeaveConversation],
  );

  function sendMessage(value = draft): void {
    const body = value.trim();
    if (!body) return;

    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setDraft("");
    setShowStarter(false);
    void sendTeamMessage(agent.id, body).catch(() => setDraft((current) => current || body));
    requestAnimationFrame(() => scrollViewRef.current?.scrollToEnd({ animated: true }));
  }

  return (
    <GestureDetector gesture={edgeBackGesture}>
      <KeyboardAvoidingView
        behavior={isIOS ? "padding" : "height"}
        className="flex-1"
        style={{ backgroundColor: background }}
      >
        <ChatHeader
          agent={agent}
          fallbackBackground={fieldBackground}
          foreground={foreground}
          liquidGlassAvailable={liquidGlassAvailable}
          topInset={insets.top}
          onBack={handleLeaveConversation}
        />
        <ChatMessageList
          ref={scrollViewRef}
          agent={agent}
          fieldBackground={fieldBackground}
          foreground={foreground}
          messages={messages}
          muted={muted}
          raised={raised}
          showStarter={showStarter && messages.length === 0}
          topInset={insets.top}
          onContentSizeChange={handleContentSizeChange}
          onScroll={handleScroll}
          onDismissStarter={() => setShowStarter(false)}
          onSelectStarter={sendMessage}
        />
        <ConnectionStatus server={servers.find((server) => server.id === agent.serverId)} />
        <ChatComposer
          action={action}
          actionForeground={actionForeground}
          agentName={agent.name}
          bottomInset={insets.bottom}
          draft={draft}
          fallbackBackground={fieldBackground}
          foreground={foreground}
          liquidGlassAvailable={liquidGlassAvailable}
          muted={muted}
          raised={raised}
          onChangeDraft={setDraft}
          onSend={() => sendMessage()}
        />
      </KeyboardAvoidingView>
    </GestureDetector>
  );
}
