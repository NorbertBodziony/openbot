import { isLiquidGlassAvailable } from "expo-glass-effect";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useThemeColor } from "heroui-native/hooks";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KeyboardAvoidingView, type ScrollView } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";

import { useBotPinTransition } from "@/features/bots/components/bot-pin-transition";
import { ChatComposer } from "@/features/chat/components/chat-composer";
import { ChatHeader } from "@/features/chat/components/chat-header";
import { type ChatMessage, ChatMessageList } from "@/features/chat/components/chat-message-list";
import type { MobileBot } from "@/features/workspace/context/mobile-workspace-context";
import { useMobileWorkspace } from "@/features/workspace/context/mobile-workspace-context";
import { isIOS } from "@/shared/lib/platform";

interface MobileChatViewProps {
  animateAvatarOnExit?: boolean;
  bot: MobileBot;
}

const CHAT_BACK_EDGE_WIDTH = 24;

function leaveConversation(): void {
  if (router.canGoBack()) router.back();
  else router.replace("/connected");
}

export function MobileChatView({ animateAvatarOnExit = false, bot }: MobileChatViewProps) {
  const insets = useSafeAreaInsets();
  const { leaveBotChatAnimated } = useBotPinTransition();
  const scrollViewRef = useRef<ScrollView>(null);
  const initialScrollBotIdRef = useRef<string | null>(bot.id);
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
  const { conversations, loadConversation, sendMessage: sendTeamMessage } = useMobileWorkspace();
  const conversation = conversations[bot.id];
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  const messages = useMemo<ChatMessage[]>(
    () =>
      (conversation?.messages ?? [])
        .filter((message) => message.text.trim().length > 0 && message.author !== "system")
        .map((message) => ({
          id: message.id,
          author: message.author === "user" ? "user" : "bot",
          body: message.text,
        })),
    [conversation],
  );
  const liquidGlassAvailable = isLiquidGlassAvailable();

  useEffect(() => {
    let active = true;
    const revisionBeforeLoad = conversationRef.current?.revision ?? null;
    initialScrollBotIdRef.current = bot.id;
    void loadConversation(bot.id)
      .then((snapshot) => {
        if (active && (revisionBeforeLoad === null || snapshot.revision > revisionBeforeLoad)) {
          initialScrollBotIdRef.current = bot.id;
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [bot.id, loadConversation]);

  const handleContentSizeChange = useCallback(() => {
    if (!conversation || initialScrollBotIdRef.current !== bot.id) return;
    initialScrollBotIdRef.current = null;
    scrollViewRef.current?.scrollToEnd({ animated: false });
  }, [bot.id, conversation]);

  const handleLeaveConversation = useCallback(() => {
    if (animateAvatarOnExit) leaveBotChatAnimated(bot.id);
    else leaveConversation();
  }, [animateAvatarOnExit, bot.id, leaveBotChatAnimated]);

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
    void sendTeamMessage(bot.id, body).catch(() => setDraft(body));
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
          bot={bot}
          fallbackBackground={fieldBackground}
          foreground={foreground}
          liquidGlassAvailable={liquidGlassAvailable}
          topInset={insets.top}
          onBack={handleLeaveConversation}
        />
        <ChatMessageList
          ref={scrollViewRef}
          bot={bot}
          fieldBackground={fieldBackground}
          foreground={foreground}
          messages={messages}
          muted={muted}
          raised={raised}
          showStarter={showStarter && messages.length === 0}
          topInset={insets.top}
          onContentSizeChange={handleContentSizeChange}
          onDismissStarter={() => setShowStarter(false)}
          onSelectStarter={sendMessage}
        />
        <ChatComposer
          action={action}
          actionForeground={actionForeground}
          botName={bot.name}
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
