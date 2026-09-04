import * as Haptics from "expo-haptics";
import { useNavigation, useRoute } from "expo-router/react-navigation";
import { type ComponentProps, createContext, useContext, useEffect, useRef } from "react";
import { Pressable } from "react-native";
import type { createChatNavigationGate } from "@/features/bots/model/chat-navigation-gate";
import { isIOS } from "@/shared/lib/platform";

export const ChatNavigationGateContext = createContext<ReturnType<typeof createChatNavigationGate> | null>(null);

// Link injects its handler here, including the AppleZoom source parameters.
// Defer that exact handler rather than recreating navigation with router.push.
export function ChatLinkPressable({ onPress, ...props }: ComponentProps<typeof Pressable>) {
  const gate = useContext(ChatNavigationGateContext);
  const route = useRoute();
  const navigation = useNavigation();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  return (
    <Pressable
      {...props}
      onPress={(event) => {
        if (event.defaultPrevented) return;
        if (isIOS) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft);
        event.persist();
        const navigate = () => {
          if (mounted.current) onPress?.(event);
        };
        if (gate && route.name === "connected") gate.request(navigate, navigation.isFocused);
        else navigate();
      }}
    />
  );
}
