import { Typography } from "heroui-native";
import { useThemeColor } from "heroui-native/hooks";
import { ChevronDown, ChevronUp, Sparkles } from "lucide-react-native";
import { useState } from "react";
import { Pressable, View } from "react-native";
import Animated, { FadeIn, ReduceMotion } from "react-native-reanimated";
import { ChatMarkdown } from "@/features/chat/components/chat-markdown";

const DETAIL_ENTER = FadeIn.duration(160).reduceMotion(ReduceMotion.System);

export function ChatThinking({ steps, working }: { steps: { id: string; text: string }[]; working: boolean }) {
  const [open, setOpen] = useState<boolean>();
  const muted = useThemeColor("muted");
  const expanded = open ?? working;
  const Chevron = expanded ? ChevronUp : ChevronDown;
  return (
    <View className="self-stretch gap-2 px-2">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={expanded ? "Hide thinking details" : "Show thinking details"}
        accessibilityState={{ expanded }}
        className="min-h-11 flex-row items-center gap-2 self-start"
        onPress={() => setOpen(!expanded)}
      >
        <Sparkles size={16} color={muted} />
        <Typography.Paragraph className="text-text-secondary" type="body-sm">
          {working ? "Thinking" : "Thought it through"}
        </Typography.Paragraph>
        <Chevron size={15} color={muted} />
      </Pressable>
      {expanded ? (
        <Animated.View entering={DETAIL_ENTER} className="gap-3 border-l border-separator pl-3 pb-2">
          {steps.map((step) => (
            <ChatMarkdown key={step.id} body={step.text} color={muted} compact />
          ))}
        </Animated.View>
      ) : null}
    </View>
  );
}
