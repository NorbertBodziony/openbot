import { GlassView } from "expo-glass-effect";
import { Button, Typography } from "heroui-native";
import { ArrowUp, Mic, Plus, X } from "lucide-react-native";
import { useEffect, useRef } from "react";
import { Alert, Pressable, TextInput, View, type ViewStyle } from "react-native";

import { ChatGlassIconButton } from "@/features/chat/components/chat-glass-icon-button";
import type { ChatTextMessage } from "@/features/chat/model/chat-messages";

interface ChatComposerProps {
  action: ViewStyle["backgroundColor"];
  actionForeground: ViewStyle["backgroundColor"];
  botName: string;
  bottomInset: number;
  disabled: boolean;
  sending: boolean;
  reply: ChatTextMessage | null;
  focusRequest: number;
  draft: string;
  fallbackBackground: ViewStyle["backgroundColor"];
  foreground: ViewStyle["backgroundColor"];
  liquidGlassAvailable: boolean;
  muted: ViewStyle["backgroundColor"];
  raised: ViewStyle["backgroundColor"];
  onChangeDraft: (value: string) => void;
  onSend: () => void;
  onCancelReply: () => void;
}

export function ChatComposer({
  action,
  actionForeground,
  botName,
  bottomInset,
  disabled,
  sending,
  reply,
  focusRequest,
  draft,
  fallbackBackground,
  foreground,
  liquidGlassAvailable,
  muted,
  raised,
  onChangeDraft,
  onSend,
  onCancelReply,
}: ChatComposerProps) {
  const hasDraft = Boolean(draft.trim());
  const inputRef = useRef<TextInput>(null);
  const handledFocusRequest = useRef(0);

  useEffect(() => {
    if (disabled) inputRef.current?.blur();
  }, [disabled]);

  useEffect(() => {
    if (disabled || focusRequest === handledFocusRequest.current) return;
    handledFocusRequest.current = focusRequest;
    inputRef.current?.focus();
  }, [disabled, focusRequest]);

  return (
    <View pointerEvents="box-none">
      {reply ? (
        <View className="mx-4 mt-2 flex-row items-center gap-2 rounded-2xl bg-control px-3 py-2">
          <View className="min-w-0 flex-1 gap-0.5">
            <Typography type="body-xs" className="text-muted">
              Replying to {reply.author === "user" ? "your message" : botName}
            </Typography>
            <Typography type="body-sm" numberOfLines={2}>
              {reply.body}
            </Typography>
          </View>
          <Button
            variant="ghost"
            isIconOnly
            className="size-11"
            accessibilityLabel="Cancel reply"
            onPress={onCancelReply}
          >
            <X color={String(muted)} size={18} />
          </Button>
        </View>
      ) : null}
      <View
        className="flex-row items-end gap-2 px-4 pt-2"
        pointerEvents="box-none"
        style={{ paddingBottom: Math.max(bottomInset, 10) }}
      >
        <ChatGlassIconButton
          accessibilityLabel="Add attachment"
          disabled={disabled}
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
            accessibilityLabel={`Message ${botName}`}
            accessibilityState={{ disabled }}
            editable={!disabled}
            showSoftInputOnFocus={!disabled}
            className="min-w-0 flex-1 font-sans text-foreground"
            placeholder={`Ask ${botName}`}
            placeholderTextColor={muted}
            returnKeyType="send"
            selectionColor={foreground}
            style={{ fontSize: 16, height: 48, paddingBottom: 0, paddingTop: 0 }}
            value={draft}
            onChangeText={onChangeDraft}
            onSubmitEditing={onSend}
          />
          <Pressable
            accessibilityLabel={sending ? "Sending message" : hasDraft ? "Send message" : "Start voice message"}
            accessibilityRole="button"
            accessibilityState={{ disabled: disabled || sending }}
            disabled={disabled || sending}
            className="size-10 items-center justify-center rounded-full"
            style={{ backgroundColor: hasDraft ? action : raised }}
            onPress={() =>
              hasDraft
                ? onSend()
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
    </View>
  );
}
