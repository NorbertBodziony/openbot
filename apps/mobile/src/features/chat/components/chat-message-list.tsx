import { Typography } from "heroui-native";
import { X } from "lucide-react-native";
import { forwardRef } from "react";
import {
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  View,
  type ViewStyle,
} from "react-native";

import { getBloubAvatarColor } from "@/features/agents/components/bloub-avatar";
import type { MobileBot } from "@/features/workspace/context/mobile-workspace-context";

export interface ChatMessage {
  id: string;
  author: "bot" | "user";
  body: string;
}

const STARTER_OPTIONS = [
  { id: "plan", label: "Plan the next steps", detail: "Turn a goal into a clear plan" },
  { id: "research", label: "Research something", detail: "Compare sources and summarize" },
  { id: "solve", label: "Work through a problem", detail: "Think it through together" },
] as const;

interface ChatMessageListProps {
  bot: MobileBot;
  fieldBackground: ViewStyle["backgroundColor"];
  foreground: ViewStyle["backgroundColor"];
  messages: ChatMessage[];
  muted: ViewStyle["backgroundColor"];
  raised: ViewStyle["backgroundColor"];
  showStarter: boolean;
  topInset: number;
  onContentSizeChange: () => void;
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onDismissStarter: () => void;
  onSelectStarter: (value: string) => void;
}

export const ChatMessageList = forwardRef<ScrollView, ChatMessageListProps>(function ChatMessageList(
  {
    bot,
    fieldBackground,
    foreground,
    messages,
    muted,
    raised,
    showStarter,
    topInset,
    onContentSizeChange,
    onScroll,
    onDismissStarter,
    onSelectStarter,
  },
  ref,
) {
  const userBubbleColor = getBloubAvatarColor(bot.avatarSeed, bot.avatarHue);

  return (
    <ScrollView
      ref={ref}
      className="flex-1"
      contentContainerStyle={{
        flexGrow: 1,
        gap: 10,
        justifyContent: "flex-end",
        paddingBottom: 20,
        paddingHorizontal: 16,
        paddingTop: topInset + 84,
      }}
      contentInsetAdjustmentBehavior="never"
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      onContentSizeChange={onContentSizeChange}
      onScroll={onScroll}
      scrollEventThrottle={16}
      showsVerticalScrollIndicator={false}
    >
      <Typography.Paragraph type="body-xs" align="center" className="pb-1 text-text-dim">
        Today
      </Typography.Paragraph>

      {messages.map((message) => (
        <View
          key={message.id}
          className={`max-w-[88%] rounded-[22px] px-4 py-3 ${message.author === "user" ? "self-end" : "self-start"}`}
          style={{
            backgroundColor: message.author === "user" ? userBubbleColor : fieldBackground,
            borderCurve: "continuous",
          }}
        >
          <Typography.Paragraph selectable style={{ color: message.author === "user" ? "#0a0a0c" : foreground }}>
            {message.body}
          </Typography.Paragraph>
        </View>
      ))}

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
                className="flex-row gap-3 px-3 py-3"
                style={({ pressed }) => ({
                  borderBottomColor: index < STARTER_OPTIONS.length - 1 ? String(muted) : "transparent",
                  borderBottomWidth: index < STARTER_OPTIONS.length - 1 ? 0.5 : 0,
                  opacity: pressed ? 0.55 : 1,
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
