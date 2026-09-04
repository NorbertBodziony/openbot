import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { Button } from "heroui-native";
import { useThemeColor } from "heroui-native/hooks";
import { Check, Copy, Reply } from "lucide-react-native";
import { type ReactNode, useState } from "react";
import { Alert, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

import type { ChatTextMessage } from "@/features/chat/model/chat-messages";

export function ChatMessageRow({
  message,
  canReply,
  onReply,
  onSelectText,
  children,
}: {
  message: ChatTextMessage;
  canReply: boolean;
  onReply: (message: ChatTextMessage) => void;
  onSelectText: (message: ChatTextMessage) => void;
  children: ReactNode;
}) {
  const muted = useThemeColor("muted");
  const [copiedBody, setCopiedBody] = useState<string | null>(null);
  const copied = copiedBody === message.body;
  const direction = message.author === "bot" ? 1 : -1;
  const translation = useSharedValue(0);
  const reducedMotion = useReducedMotion();
  const reply = () => {
    if (!canReply) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onReply(message);
  };
  const pan = Gesture.Pan()
    .enabled(canReply)
    .activeOffsetX(direction * 14)
    .failOffsetX(direction * -10)
    .failOffsetY([-10, 10])
    .onTouchesDown((event, manager) => {
      // Leave the screen's left-edge back gesture available.
      if (event.allTouches[0]?.absoluteX < 24) manager.fail();
    })
    .onUpdate((event) => {
      const distance = Math.max(0, direction * event.translationX);
      translation.set(direction * (distance <= 64 ? distance : 64 + Math.sqrt(distance - 64)));
    })
    .onEnd((event) => {
      const distance = direction * event.translationX;
      if (distance >= 64 || (distance >= 24 && direction * event.velocityX >= 650)) scheduleOnRN(reply);
    })
    .onFinalize((event) => {
      translation.set(
        withSpring(0, {
          duration: 400,
          dampingRatio: 0.8,
          velocity: event.velocityX,
          reduceMotion: ReduceMotion.System,
        }),
      );
    });
  const movement = useAnimatedStyle(() => ({ transform: [{ translateX: reducedMotion ? 0 : translation.get() }] }));
  const hint = useAnimatedStyle(() => ({ opacity: Math.min(1, Math.abs(translation.get()) / 64) }));
  const openSelection = () => onSelectText(message);
  const selectText = Gesture.LongPress()
    .minDuration(450)
    .maxDistance(10)
    .onStart(() => scheduleOnRN(openSelection));

  async function copyMessage() {
    try {
      const saved = await Clipboard.setStringAsync(message.body);
      if (!saved) throw new Error("Clipboard unavailable");
      setCopiedBody(message.body);
    } catch {
      Alert.alert("Couldn’t copy message", "Please try again.");
    }
  }

  return (
    <View className="gap-1">
      <View>
        <Animated.View
          pointerEvents="none"
          accessible={false}
          className={`absolute top-4 ${direction === 1 ? "left-2" : "right-2"}`}
          style={hint}
        >
          <Reply color={muted} size={20} />
        </Animated.View>
        <GestureDetector gesture={Gesture.Race(pan, selectText)}>
          <Animated.View
            className={`max-w-[88%] ${message.author === "user" ? "self-end" : "self-start"}`}
            style={movement}
          >
            {children}
          </Animated.View>
        </GestureDetector>
      </View>
      <View className={`flex-row ${message.author === "user" ? "self-end" : "self-start"}`}>
        <Button
          variant="ghost"
          size="sm"
          isIconOnly
          className="size-11"
          accessibilityLabel="Reply"
          isDisabled={!canReply}
          onPress={reply}
        >
          <Reply color={muted} size={16} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          isIconOnly
          className="size-11"
          accessibilityLabel={copied ? "Copied" : "Copy message"}
          accessibilityActions={[{ name: "selectText", label: "Select text" }]}
          onAccessibilityAction={({ nativeEvent }) => {
            if (nativeEvent.actionName === "selectText") onSelectText(message);
          }}
          onPress={() => void copyMessage()}
        >
          {copied ? <Check color={muted} size={16} /> : <Copy color={muted} size={16} />}
        </Button>
      </View>
    </View>
  );
}
