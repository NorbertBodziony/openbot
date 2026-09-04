import { GlassView } from "expo-glass-effect";
import { ArrowUp, Mic, Plus } from "lucide-react-native";
import { Alert, Pressable, TextInput, View, type ViewStyle } from "react-native";

import { ChatGlassIconButton } from "@/features/chat/components/chat-glass-icon-button";

interface ChatComposerProps {
  action: ViewStyle["backgroundColor"];
  actionForeground: ViewStyle["backgroundColor"];
  botName: string;
  bottomInset: number;
  draft: string;
  fallbackBackground: ViewStyle["backgroundColor"];
  foreground: ViewStyle["backgroundColor"];
  liquidGlassAvailable: boolean;
  muted: ViewStyle["backgroundColor"];
  raised: ViewStyle["backgroundColor"];
  onChangeDraft: (value: string) => void;
  onSend: () => void;
}

export function ChatComposer({
  action,
  actionForeground,
  botName,
  bottomInset,
  draft,
  fallbackBackground,
  foreground,
  liquidGlassAvailable,
  muted,
  raised,
  onChangeDraft,
  onSend,
}: ChatComposerProps) {
  const hasDraft = Boolean(draft.trim());

  return (
    <View
      className="flex-row items-end gap-2 px-4 pt-2"
      pointerEvents="box-none"
      style={{ paddingBottom: Math.max(bottomInset, 10) }}
    >
      <ChatGlassIconButton
        accessibilityLabel="Add attachment"
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
          paddingLeft: 16,
          paddingRight: 5,
        }}
      >
        <TextInput
          accessibilityLabel={`Message ${botName}`}
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
          accessibilityLabel={hasDraft ? "Send message" : "Start voice message"}
          accessibilityRole="button"
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
  );
}
