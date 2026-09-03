import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import * as Haptics from "expo-haptics";
import { Link, router } from "expo-router";
import { Typography } from "heroui-native";
import { useThemeColor } from "heroui-native/hooks";
import { ArrowLeft, ArrowUp, Mic, Monitor, Plus, X } from "lucide-react-native";
import { useCallback, useMemo, useRef, useState } from "react";
import { Alert, KeyboardAvoidingView, Pressable, ScrollView, TextInput, View, type ViewStyle } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";

import { BloubAvatar, getBloubAvatarColor } from "@/components/bloub-avatar";
import { BotPinAvatar, useBotPinTransition } from "@/components/bot-pin-transition";
import { SheetScrollEdgeEffect } from "@/components/sheet-scroll-edge-effect";
import { isIOS } from "@/lib/platform";
import type { MobileBot } from "@/providers/mobile-workspace-provider";

interface MobileChatViewProps {
  animateAvatarOnExit?: boolean;
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

export function MobileChatView({ animateAvatarOnExit = false, bot, userName }: MobileChatViewProps) {
  const insets = useSafeAreaInsets();
  const { leaveBotChatAnimated } = useBotPinTransition();
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
  const userBubbleColor = getBloubAvatarColor(bot.avatarSeed);
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
            onPress={handleLeaveConversation}
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
              <BotPinAvatar botId={bot.id} location="chat" size={28}>
                <BloubAvatar seed={bot.avatarSeed} size={28} />
              </BotPinAvatar>
            </Link.AppleZoomTarget>
            <Typography.Paragraph className="min-w-0 shrink" weight="semibold" numberOfLines={1}>
              {bot.name}
            </Typography.Paragraph>
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

        <SheetScrollEdgeEffect
          style={{ height: insets.top + 82, left: 0, position: "absolute", right: 0, top: 0, zIndex: 10 }}
        />

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
