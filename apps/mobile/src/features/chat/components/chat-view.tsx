import { isLiquidGlassAvailable } from "expo-glass-effect";
import * as Haptics from "expo-haptics";
import { router, useIsFocused } from "expo-router";
import { useThemeColor } from "heroui-native/hooks";
import { type ComponentRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";

import { useBotPinTransition } from "@/features/bots/components/bot-pin-transition";
import { ChatComposer } from "@/features/chat/components/chat-composer";
import { ChatHeader } from "@/features/chat/components/chat-header";
import { ChatMessageList } from "@/features/chat/components/chat-message-list";
import { projectChatMessages } from "@/features/chat/model/chat-messages";
import { ConnectionStatus } from "@/features/workspace/components/connection-status";
import { useBotActivity } from "@/features/workspace/components/use-bot-activity";
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
  const isFocused = useIsFocused();
  const [appActive, setAppActive] = useState(AppState.currentState === "active");
  const [atLatest, setAtLatest] = useState(false);
  const [composerHeight, setComposerHeight] = useState(0);
  const insets = useSafeAreaInsets();
  const keyboardOffset = Math.max(insets.bottom, 10) - 10;
  const { leaveBotChatAnimated } = useBotPinTransition();
  const scrollViewRef = useRef<ComponentRef<typeof ChatMessageList>>(null);
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
  const [historyLoadFailed, setHistoryLoadFailed] = useState(false);
  const historyRequestRef = useRef(0);
  const { conversations, loadConversation, markBotRead, servers, sendMessage: sendTeamMessage } = useMobileWorkspace();
  const conversation = conversations[bot.id];
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  const activity = useBotActivity(bot.id);
  const messages = useMemo(() => projectChatMessages(conversation?.messages ?? []), [conversation]);
  const liquidGlassAvailable = isLiquidGlassAvailable();
  const latestMessage = conversation?.messages.findLast(
    (message) => message.author !== "system" && message.text.trim().length > 0,
  );
  const readBoundary = latestMessage?.id;
  const readBoundaryStatus = latestMessage?.status;
  const server = servers.find((server) => server.id === bot.serverId);
  const serverOnline = server?.state === "online";

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => setAppActive(state === "active"));
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (isFocused && appActive && atLatest && serverOnline && readBoundary && readBoundaryStatus) {
      markBotRead(bot.id, readBoundary);
    }
  }, [isFocused, appActive, atLatest, serverOnline, readBoundary, readBoundaryStatus, bot.id, markBotRead]);

  useEffect(() => {
    setAtLatest(false);
    initialScrollBotIdRef.current = bot.id;
  }, [bot.id]);

  const fetchHistory = useCallback(() => {
    if (!serverOnline) return;
    const requestId = ++historyRequestRef.current;
    const revisionBeforeLoad = conversationRef.current?.revision ?? null;
    setHistoryLoadFailed(false);
    void loadConversation(bot.id)
      .then((snapshot) => {
        if (
          historyRequestRef.current === requestId &&
          (revisionBeforeLoad === null || snapshot.revision > revisionBeforeLoad)
        ) {
          initialScrollBotIdRef.current = bot.id;
        }
      })
      .catch(() => {
        if (historyRequestRef.current === requestId) setHistoryLoadFailed(true);
      });
  }, [bot.id, loadConversation, serverOnline]);

  useEffect(() => {
    fetchHistory();
    return () => {
      historyRequestRef.current += 1;
    };
  }, [fetchHistory]);

  const handleContentSizeChange = useCallback(() => {
    if (!conversation || (initialScrollBotIdRef.current !== bot.id && !atLatest)) return;
    initialScrollBotIdRef.current = null;
    scrollViewRef.current?.scrollToEnd({ animated: false });
    setAtLatest(true);
  }, [atLatest, bot.id, conversation]);

  const handleLeaveConversation = useCallback(() => {
    if (animateAvatarOnExit) leaveBotChatAnimated(bot.id);
    else leaveConversation();
  }, [animateAvatarOnExit, bot.id, leaveBotChatAnimated]);

  const edgeBackGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(!isIOS)
        .hitSlop({ left: 0, width: CHAT_BACK_EDGE_WIDTH })
        .activeOffsetX(12)
        .failOffsetX(-8)
        .failOffsetY([-16, 16])
        .onEnd((event) => {
          if (event.translationX >= 48 || event.velocityX >= 650) scheduleOnRN(handleLeaveConversation);
        }),
    [handleLeaveConversation],
  );

  function sendMessage(value: string): void {
    if (!serverOnline) return;
    const body = value.trim();
    if (!body) return;

    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setDraft("");
    setShowStarter(false);
    void sendTeamMessage(bot.id, body).catch(() => setDraft((current) => current || body));
    requestAnimationFrame(() => scrollViewRef.current?.scrollToEnd({ animated: true }));
  }

  return (
    <GestureDetector gesture={edgeBackGesture}>
      <View className="flex-1" style={{ backgroundColor: background }}>
        <View className="flex-1">
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
            bottomInset={composerHeight}
            keyboardOffset={keyboardOffset}
            canSend={serverOnline}
            historyState={
              conversation
                ? "ready"
                : server?.initialConnectionPending
                  ? "connecting"
                  : !serverOnline
                    ? "waiting"
                    : historyLoadFailed
                      ? "error"
                      : "loading"
            }
            appActive={appActive}
            fieldBackground={fieldBackground}
            foreground={foreground}
            messages={messages}
            muted={muted}
            raised={raised}
            showStarter={showStarter && serverOnline && !activity && conversation?.messages.length === 0}
            topInset={insets.top}
            onContentSizeChange={handleContentSizeChange}
            onEndVisible={setAtLatest}
            onDismissStarter={() => setShowStarter(false)}
            onSelectStarter={sendMessage}
            onRetryHistory={fetchHistory}
          />
          <KeyboardStickyView
            style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}
            offset={{ opened: keyboardOffset }}
            pointerEvents="box-none"
            onLayout={({ nativeEvent: { layout } }) => setComposerHeight(layout.height)}
          >
            <ConnectionStatus server={server} />
            <ChatComposer
              action={action}
              actionForeground={actionForeground}
              botName={bot.name}
              bottomInset={insets.bottom}
              disabled={!serverOnline}
              draft={draft}
              fallbackBackground={fieldBackground}
              foreground={foreground}
              liquidGlassAvailable={liquidGlassAvailable}
              muted={muted}
              raised={raised}
              onChangeDraft={setDraft}
              onSend={sendMessage}
            />
          </KeyboardStickyView>
        </View>
      </View>
    </GestureDetector>
  );
}
