import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { AgentPromptQuestion } from "@openbot/contracts/ipc";
import { GlassView } from "expo-glass-effect";
import { ArrowUp, Mic, Plus } from "lucide-react-native";
import { useEffect, useRef } from "react";
import { Alert, Pressable, TextInput, View, type ViewStyle } from "react-native";

import { ChatGlassIconButton } from "@/features/chat/components/chat-glass-icon-button";

interface ChatComposerProps {
  action: ViewStyle["backgroundColor"];
  actionForeground: ViewStyle["backgroundColor"];
  botName: string;
  bottomInset: number;
  disabled: boolean;
  draft: string;
  answerQuestion?: AgentPromptQuestion;
  fallbackBackground: ViewStyle["backgroundColor"];
  foreground: ViewStyle["backgroundColor"];
  liquidGlassAvailable: boolean;
  muted: ViewStyle["backgroundColor"];
  raised: ViewStyle["backgroundColor"];
  onChangeDraft: (value: string) => void;
  onSend: (text: string) => void;
}

export function ChatComposer({
  action,
  actionForeground,
  botName,
  bottomInset,
  disabled,
  draft,
  answerQuestion,
  fallbackBackground,
  foreground,
  liquidGlassAvailable,
  muted,
  raised,
  onChangeDraft,
  onSend,
}: ChatComposerProps) {
  const hasDraft = Boolean(draft.trim());
  const inputRef = useRef<TextInput>(null);
  const editingRef = useRef(false);
  const latestTextRef = useRef(draft);
  const sendAfterEditingRef = useRef(false);

  useEffect(() => {
    latestTextRef.current = draft;
  }, [draft]);

  useEffect(() => {
    if (disabled) {
      sendAfterEditingRef.current = false;
      inputRef.current?.blur();
    }
  }, [disabled]);

  function requestSend(): void {
    if (disabled || sendAfterEditingRef.current) return;
    if (editingRef.current && inputRef.current) {
      // Ending native editing commits pending autocorrection before sending.
      sendAfterEditingRef.current = true;
      inputRef.current.blur();
    } else {
      onSend(latestTextRef.current);
    }
  }

  return (
    <View
      className="flex-row items-end gap-2 px-4 pt-2"
      pointerEvents="box-none"
      style={{ paddingBottom: Math.max(bottomInset, 10) }}
    >
      <ChatGlassIconButton
        accessibilityLabel="Add attachment"
        disabled={disabled || Boolean(answerQuestion)}
        fallbackBackground={fallbackBackground}
        liquidGlassAvailable={liquidGlassAvailable}
        onPress={() => Alert.alert("Attachments", "Attachments will be connected with the conversation API.")}
      >
        <Plus color={String(foreground)} size={25} strokeWidth={1.8} />
      </ChatGlassIconButton>

      <GlassView
        glassEffectStyle={liquidGlassAvailable ? "regular" : "none"}
        style={{
          alignItems: "center",
          backgroundColor: liquidGlassAvailable ? "transparent" : fallbackBackground,
          borderCurve: "continuous",
          borderRadius: 24,
          flex: 1,
          flexDirection: "row",
          height: 48,
          overflow: "hidden",
          opacity: disabled ? 0.45 : 1,
          paddingLeft: 16,
          paddingRight: 5,
        }}
      >
        <TextInput
          ref={inputRef}
          accessibilityLabel={answerQuestion?.question ?? `Message ${botName}`}
          accessibilityState={{ disabled }}
          editable={!disabled}
          showSoftInputOnFocus={!disabled}
          className="min-w-0 flex-1 font-sans text-foreground"
          placeholder={
            answerQuestion
              ? answerQuestion.isSecret
                ? "Enter a private answer"
                : "Type your answer"
              : `Ask ${botName}`
          }
          secureTextEntry={answerQuestion?.isSecret ?? false}
          autoCorrect={!answerQuestion?.isSecret}
          autoCapitalize={answerQuestion?.isSecret ? "none" : "sentences"}
          maxLength={answerQuestion ? INPUT_LIMITS.promptAnswerText : undefined}
          placeholderTextColor={muted}
          returnKeyType="send"
          submitBehavior="blurAndSubmit"
          selectionColor={foreground}
          style={{ fontSize: 16, height: 48, paddingBottom: 0, paddingTop: 0 }}
          value={draft}
          onFocus={() => {
            editingRef.current = true;
          }}
          onChangeText={(text) => {
            latestTextRef.current = text;
            onChangeDraft(text);
          }}
          onSubmitEditing={() => {
            if (!disabled) sendAfterEditingRef.current = true;
          }}
          onEndEditing={({ nativeEvent: { text } }) => {
            // Native editing can end before the send button's release event,
            // while TextInput.isFocused() is still waiting for onBlur.
            editingRef.current = false;
            latestTextRef.current = text;
            if (!sendAfterEditingRef.current) return;
            sendAfterEditingRef.current = false;
            if (!disabled) onSend(text);
          }}
        />
        <Pressable
          accessibilityLabel={hasDraft ? (answerQuestion ? "Send answer" : "Send message") : "Start voice message"}
          accessibilityRole="button"
          accessibilityState={{ disabled }}
          disabled={disabled}
          className="size-10 items-center justify-center rounded-full"
          style={{ backgroundColor: hasDraft ? action : raised }}
          onPress={() =>
            hasDraft
              ? requestSend()
              : Alert.alert("Voice messages", "Voice input will be connected with the conversation API.")
          }
        >
          {hasDraft ? (
            <ArrowUp color={String(actionForeground)} size={21} strokeWidth={2.2} />
          ) : (
            <Mic color={String(muted)} size={21} strokeWidth={2} />
          )}
        </Pressable>
      </GlassView>
    </View>
  );
}
