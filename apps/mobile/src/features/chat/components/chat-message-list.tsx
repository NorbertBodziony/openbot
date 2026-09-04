import { useIsFocused } from "expo-router";
import { Button, Typography } from "heroui-native";
import { X } from "lucide-react-native";
import { forwardRef, useRef } from "react";
import {
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  View,
  type ViewStyle,
} from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { BloubAvatar, getBloubAvatarColor } from "@/features/bots/components/bloub-avatar";
import { ChatMarkdown } from "@/features/chat/components/chat-markdown";
import { ChatThinking } from "@/features/chat/components/chat-thinking";
import type { ChatMessage } from "@/features/chat/model/chat-messages";
import { useBotActivity } from "@/features/workspace/components/use-bot-activity";
import { useConnectionAppearance } from "@/features/workspace/components/use-connection-appearance";
import type { MobileBot } from "@/features/workspace/context/mobile-workspace-context";

const STARTER_OPTIONS = [
  { id: "plan", label: "Plan the next steps", detail: "Turn a goal into a clear plan" },
  { id: "research", label: "Research something", detail: "Compare sources and summarize" },
  { id: "solve", label: "Work through a problem", detail: "Think it through together" },
] as const;

interface ChatMessageListProps {
  bot: MobileBot;
  bottomInset: number;
  canSend: boolean;
  appActive: boolean;
  fieldBackground: ViewStyle["backgroundColor"];
  foreground: ViewStyle["backgroundColor"];
  historyState: "ready" | "connecting" | "waiting" | "loading" | "error";
  messages: ChatMessage[];
  muted: ViewStyle["backgroundColor"];
  raised: ViewStyle["backgroundColor"];
  showStarter: boolean;
  topInset: number;
  onContentSizeChange: () => void;
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onDismissStarter: () => void;
  onSelectStarter: (value: string) => void;
  onRetryHistory: () => void;
}

export const ChatMessageList = forwardRef<ScrollView, ChatMessageListProps>(function ChatMessageList(
  {
    bot,
    bottomInset,
    canSend,
    appActive,
    fieldBackground,
    foreground,
    historyState,
    messages,
    muted,
    raised,
    showStarter,
    topInset,
    onContentSizeChange,
    onScroll,
    onDismissStarter,
    onSelectStarter,
    onRetryHistory,
  },
  ref,
) {
  const isFocused = useIsFocused();
  const animateMessages = isFocused && canSend && appActive;
  const initialMessages = useRef<{ botId: string; ids: Set<string>; live: boolean } | null>(null);
  if (
    historyState === "ready" &&
    (initialMessages.current?.botId !== bot.id || !animateMessages || !initialMessages.current?.live)
  ) {
    initialMessages.current = {
      botId: bot.id,
      ids: new Set(messages.map((message) => message.id)),
      live: animateMessages,
    };
  }
  const activity = useBotActivity(bot.id);
  const activityLabel =
    activity?.phase === "waiting"
      ? "Waiting for your input on desktop"
      : activity?.phase === "responding"
        ? "Responding…"
        : activity?.detail || "Thinking…";
  const userBubbleColor = getBloubAvatarColor(bot.avatarSeed, bot.avatarHue);
  const appearance = useConnectionAppearance(!canSend);
  const red = Number.parseInt(userBubbleColor.slice(1, 3), 16);
  const green = Number.parseInt(userBubbleColor.slice(3, 5), 16);
  const blue = Number.parseInt(userBubbleColor.slice(5, 7), 16);
  const gray = red * 0.213 + green * 0.715 + blue * 0.072;
  const userBubbleStyle = useAnimatedStyle(() => {
    const { saturation } = appearance.get();
    const r = Math.round(gray + (red - gray) * saturation);
    const g = Math.round(gray + (green - gray) * saturation);
    const b = Math.round(gray + (blue - gray) * saturation);
    // Fade the color while keeping message text fully readable.
    return { backgroundColor: `rgb(${r}, ${g}, ${b})` };
  });

  return (
    <ScrollView
      ref={ref}
      className="flex-1"
      contentContainerStyle={{
        flexGrow: 1,
        gap: 10,
        justifyContent: "flex-end",
        paddingBottom: bottomInset + 20,
        paddingHorizontal: 16,
        paddingTop: topInset + 84,
      }}
      contentInsetAdjustmentBehavior="never"
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      onContentSizeChange={onContentSizeChange}
      onLayout={onContentSizeChange}
      onScroll={onScroll}
      scrollEventThrottle={16}
      showsVerticalScrollIndicator={false}
    >
      {historyState === "connecting" || historyState === "loading" ? (
        <View
          className="flex-1"
          accessible
          accessibilityLabel={historyState === "connecting" ? "Connecting to server" : "Loading chat history"}
          accessibilityState={{ busy: true }}
        />
      ) : historyState !== "ready" ? (
        <View className="flex-1 items-center justify-center gap-2">
          <Typography.Paragraph align="center" className="text-text-secondary">
            {historyState === "waiting" ? "Waiting for connection" : "Could not load chat history"}
          </Typography.Paragraph>
          {historyState === "waiting" ? (
            <Typography.Paragraph type="body-xs" align="center" className="text-text-dim">
              Your chat history will load when the server reconnects.
            </Typography.Paragraph>
          ) : null}
          {historyState === "error" ? (
            <Button variant="tertiary" onPress={onRetryHistory}>
              <Button.Label>Try again</Button.Label>
            </Button>
          ) : null}
        </View>
      ) : null}

      {messages.map((message) =>
        message.kind === "thinking" ? (
          <ChatThinking
            key={message.id}
            steps={message.steps}
            working={Boolean(activity && activity.turnId === message.turnId)}
          />
        ) : (
          <Animated.View
            key={message.id}
            className={`max-w-[88%] rounded-[30px] px-4 py-3 ${message.author === "user" ? "self-end" : "self-start bg-control/60"}`}
            style={[{ borderCurve: "circular" }, message.author === "user" ? userBubbleStyle : undefined]}
          >
            <ChatMarkdown
              body={message.body}
              color={message.author === "user" ? "#0a0a0c" : foreground}
              streaming={message.author === "bot" && message.streaming}
              animateInitial={message.author === "bot" && !initialMessages.current?.ids.has(message.id)}
              animationEnabled={animateMessages}
            />
          </Animated.View>
        ),
      )}

      {activity ? (
        <View
          className="flex-row items-center gap-2 px-1 py-2"
          accessible
          accessibilityLiveRegion="polite"
          accessibilityRole="text"
          accessibilityLabel={`${bot.name}: ${activityLabel}`}
        >
          <BloubAvatar botId={bot.id} hue={bot.avatarHue} seed={bot.avatarSeed} size={36} />
          <Typography.Paragraph type="body-sm" className="flex-1 text-text-secondary">
            {activityLabel}
          </Typography.Paragraph>
        </View>
      ) : null}

      {showStarter ? (
        <View
          className="gap-4 rounded-[26px] p-4"
          style={{ backgroundColor: fieldBackground, borderCurve: "continuous" }}
        >
          <View className="flex-row items-start gap-3">
            <View className="min-w-0 flex-1 gap-1">
              <Typography.Heading type="h4">What should we work on first?</Typography.Heading>
              <Typography.Paragraph className="text-text-secondary">
                Pick one, or type your own — we can change course anytime.
              </Typography.Paragraph>
            </View>
            <Pressable
              accessibilityLabel="Dismiss suggestions"
              accessibilityRole="button"
              hitSlop={8}
              onPress={onDismissStarter}
            >
              <X color={String(muted)} size={21} strokeWidth={1.8} />
            </Pressable>
          </View>

          <View className="overflow-hidden rounded-[18px]" style={{ backgroundColor: raised }}>
            {STARTER_OPTIONS.map((option, index) => (
              <Pressable
                key={option.id}
                accessibilityRole="button"
                accessibilityState={{ disabled: !canSend }}
                disabled={!canSend}
                className="flex-row gap-3 px-3 py-3"
                style={({ pressed }) => ({
                  borderBottomColor: index < STARTER_OPTIONS.length - 1 ? String(muted) : "transparent",
                  borderBottomWidth: index < STARTER_OPTIONS.length - 1 ? 0.5 : 0,
                  opacity: !canSend ? 0.45 : pressed ? 0.55 : 1,
                })}
                onPress={() => onSelectStarter(option.label)}
              >
                <View className="size-7 items-center justify-center rounded-lg bg-control">
                  <Typography.Paragraph type="body-xs" className="text-text-secondary">
                    {String.fromCharCode(65 + index)}
                  </Typography.Paragraph>
                </View>
                <View className="min-w-0 flex-1">
                  <Typography.Paragraph weight="medium">{option.label}</Typography.Paragraph>
                  <Typography.Paragraph type="body-xs" className="text-text-secondary">
                    {option.detail}
                  </Typography.Paragraph>
                </View>
              </Pressable>
            ))}
          </View>

          <Typography.Paragraph type="body-xs" className="text-text-secondary">
            Or answer in the chat below
          </Typography.Paragraph>
        </View>
      ) : null}
    </ScrollView>
  );
});
