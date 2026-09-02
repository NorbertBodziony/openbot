import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import * as Haptics from "expo-haptics";
import { Link, router } from "expo-router";
import { useThemeColor } from "heroui-native/hooks";
import { ArrowLeft, ArrowUp, Mic, Monitor, Plus, X } from "lucide-react-native";
import { useMemo, useRef, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type ViewStyle,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";

import { BloubAvatar } from "@/components/bloub-avatar";
import { isIOS } from "@/lib/platform";
import type { MobileBot } from "@/providers/mobile-workspace-provider";

interface MobileChatViewProps {
  bot: MobileBot;
  userName: string;
}

interface ChatMessage {
  id: string;
  author: "bot" | "user";
  body: string;
}

const STARTER_OPTIONS = [
  { id: "plan", label: "Plan the next steps", detail: "Turn a goal into a clear plan" },
  { id: "research", label: "Research something", detail: "Compare sources and summarize" },
  { id: "solve", label: "Work through a problem", detail: "Think it through together" },
] as const;

const CHAT_BACK_EDGE_WIDTH = 24;

function leaveConversation(): void {
  if (router.canGoBack()) router.back();
  else router.replace("/connected");
}

export function MobileChatView({ bot, userName }: MobileChatViewProps) {
  const insets = useSafeAreaInsets();
  const scrollViewRef = useRef<ScrollView>(null);
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
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: `${bot.id}-hello`,
      author: "bot",
      body: `Hey ${userName} — I’m ${bot.name}. ${bot.preview}\n\nWhat do you want to work on right now?`,
    },
  ]);
  const liquidGlassAvailable = isLiquidGlassAvailable();
  const iconColor = String(foreground);
  const edgeBackGesture = useMemo(
    () =>
      Gesture.Pan()
        .hitSlop({ left: 0, width: CHAT_BACK_EDGE_WIDTH })
        .activeOffsetX(12)
        .failOffsetX(-8)
        .failOffsetY([-16, 16])
        .onEnd((event) => {
          if (event.translationX >= 48 || event.velocityX >= 650) scheduleOnRN(leaveConversation);
        }),
    [],
  );

  function sendMessage(value = draft): void {
    const body = value.trim();
    if (!body) return;

    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setMessages((current) => [...current, { id: `user-${Date.now()}`, author: "user", body }]);
    setDraft("");
    setShowStarter(false);
    requestAnimationFrame(() => scrollViewRef.current?.scrollToEnd({ animated: true }));
  }

  return (
    <GestureDetector gesture={edgeBackGesture}>
      <KeyboardAvoidingView
        behavior={isIOS ? "padding" : "height"}
        className="flex-1"
        style={{ backgroundColor: background }}
      >
        <View
          className="absolute inset-x-0 z-20 flex-row items-center gap-2 px-4"
          pointerEvents="box-none"
          style={{ top: insets.top + 8 }}
        >
          <ChatGlassIconButton
            accessibilityLabel="Back"
            fallbackBackground={fieldBackground}
            liquidGlassAvailable={liquidGlassAvailable}
            onPress={leaveConversation}
          >
            <ArrowLeft color={iconColor} size={24} strokeWidth={2} />
          </ChatGlassIconButton>

          <GlassView
            glassEffectStyle={liquidGlassAvailable ? "regular" : "none"}
            style={{
              alignItems: "center",
              alignSelf: "stretch",
              backgroundColor: liquidGlassAvailable ? "transparent" : fieldBackground,
              borderCurve: "continuous",
              borderRadius: 24,
              flexDirection: "row",
              gap: 8,
              maxWidth: 220,
              overflow: "hidden",
              paddingHorizontal: 12,
            }}
          >
            <Link.AppleZoomTarget>
              <View style={{ height: 28, width: 28 }}>
                <BloubAvatar seed={bot.avatarSeed} size={28} />
              </View>
            </Link.AppleZoomTarget>
            <Text className="min-w-0 shrink font-sans text-body font-semibold text-foreground" numberOfLines={1}>
              {bot.name}
            </Text>
          </GlassView>

          <View className="flex-1" />

          <ChatGlassIconButton
            accessibilityLabel="Open on desktop"
            fallbackBackground={fieldBackground}
            liquidGlassAvailable={liquidGlassAvailable}
            onPress={() => Alert.alert("Open on desktop", "Desktop handoff will be connected with the server API.")}
          >
            <Monitor color={iconColor} size={22} strokeWidth={1.9} />
          </ChatGlassIconButton>
        </View>

        <ScrollView
          ref={scrollViewRef}
          className="flex-1"
          contentContainerStyle={{
            flexGrow: 1,
            gap: 10,
            justifyContent: "flex-end",
            paddingBottom: 20,
            paddingHorizontal: 16,
            paddingTop: insets.top + 84,
          }}
          contentInsetAdjustmentBehavior="never"
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          onContentSizeChange={() => scrollViewRef.current?.scrollToEnd({ animated: false })}
        >
          <Text className="pb-1 text-center font-sans text-caption text-text-dim">Today</Text>

          {messages.map((message) => (
            <View
              key={message.id}
              className={`max-w-[88%] rounded-[22px] px-4 py-3 ${message.author === "user" ? "self-end" : "self-start"}`}
              style={{
                backgroundColor: message.author === "user" ? action : fieldBackground,
                borderCurve: "continuous",
              }}
            >
              <Text
                className="font-sans text-body"
                selectable
                style={{ color: message.author === "user" ? actionForeground : foreground }}
              >
                {message.body}
              </Text>
            </View>
          ))}

          {showStarter ? (
            <View
              className="gap-4 rounded-[26px] p-4"
              style={{ backgroundColor: fieldBackground, borderCurve: "continuous" }}
            >
              <View className="flex-row items-start gap-3">
                <View className="min-w-0 flex-1 gap-1">
                  <Text className="font-sans text-title font-semibold text-foreground">
                    What should we work on first?
                  </Text>
                  <Text className="font-sans text-body text-text-secondary">
                    Pick one, or type your own — we can change course anytime.
                  </Text>
                </View>
                <Pressable
                  accessibilityLabel="Dismiss suggestions"
                  accessibilityRole="button"
                  hitSlop={8}
                  onPress={() => setShowStarter(false)}
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
                    onPress={() => sendMessage(option.label)}
                  >
                    <View className="size-7 items-center justify-center rounded-lg bg-control">
                      <Text className="font-sans text-caption text-text-secondary">
                        {String.fromCharCode(65 + index)}
                      </Text>
                    </View>
                    <View className="min-w-0 flex-1">
                      <Text className="font-sans text-body font-medium text-foreground">{option.label}</Text>
                      <Text className="font-sans text-caption text-text-secondary">{option.detail}</Text>
                    </View>
                  </Pressable>
                ))}
              </View>

              <Text className="font-sans text-caption text-text-secondary">Or answer in the chat below</Text>
            </View>
          ) : null}
        </ScrollView>

        <View className="flex-row items-end gap-2 px-4 pt-2" style={{ paddingBottom: Math.max(insets.bottom, 10) }}>
          <ChatGlassIconButton
            accessibilityLabel="Add attachment"
            fallbackBackground={fieldBackground}
            liquidGlassAvailable={liquidGlassAvailable}
            onPress={() => Alert.alert("Attachments", "Attachments will be connected with the conversation API.")}
          >
            <Plus color={iconColor} size={25} strokeWidth={1.8} />
          </ChatGlassIconButton>

          <GlassView
            glassEffectStyle={liquidGlassAvailable ? "regular" : "none"}
            style={{
              alignItems: "center",
              backgroundColor: liquidGlassAvailable ? "transparent" : fieldBackground,
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
              accessibilityLabel={`Message ${bot.name}`}
              className="min-w-0 flex-1 font-sans text-foreground"
              placeholder={`Ask ${bot.name}`}
              placeholderTextColor={muted}
              returnKeyType="send"
              selectionColor={foreground}
              style={{ fontSize: 16, height: 48, paddingBottom: 0, paddingTop: 0 }}
              value={draft}
              onChangeText={setDraft}
              onSubmitEditing={() => sendMessage()}
            />
            <Pressable
              accessibilityLabel={draft.trim() ? "Send message" : "Start voice message"}
              accessibilityRole="button"
              className="size-10 items-center justify-center rounded-full"
              style={{ backgroundColor: draft.trim() ? action : raised }}
              onPress={() =>
                draft.trim()
                  ? sendMessage()
                  : Alert.alert("Voice messages", "Voice input will be connected with the conversation API.")
              }
            >
              {draft.trim() ? (
                <ArrowUp color={String(actionForeground)} size={21} strokeWidth={2.2} />
              ) : (
                <Mic color={String(muted)} size={21} strokeWidth={2} />
              )}
            </Pressable>
          </GlassView>
        </View>
      </KeyboardAvoidingView>
    </GestureDetector>
  );
}

function ChatGlassIconButton({
  accessibilityLabel,
  children,
  fallbackBackground,
  liquidGlassAvailable,
  onPress,
}: {
  accessibilityLabel: string;
  children: React.ReactNode;
  fallbackBackground: ViewStyle["backgroundColor"];
  liquidGlassAvailable: boolean;
  onPress: () => void;
}) {
  return (
    <GlassView
      glassEffectStyle={liquidGlassAvailable ? "regular" : "none"}
      isInteractive={liquidGlassAvailable}
      style={{
        backgroundColor: liquidGlassAvailable ? "transparent" : fallbackBackground,
        borderCurve: "continuous",
        borderRadius: 24,
        height: 48,
        overflow: "hidden",
        width: 48,
      }}
    >
      <Pressable
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="button"
        className="flex-1 items-center justify-center"
        hitSlop={4}
        style={({ pressed }) => ({ opacity: pressed ? 0.55 : 1 })}
        onPress={onPress}
      >
        {children}
      </Pressable>
    </GlassView>
  );
}
