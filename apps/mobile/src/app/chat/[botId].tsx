import { router, Stack, useLocalSearchParams, usePreventZoomTransitionDismissal } from "expo-router";
import { useThemeColor } from "heroui-native/hooks";
import { ArrowLeft } from "lucide-react-native";
import { Pressable, Text, View } from "react-native";

import { MobileChatView } from "@/components/mobile-chat-view";
import { useMobileSession } from "@/providers/mobile-session-provider";
import { useMobileWorkspace } from "@/providers/mobile-workspace-provider";

export default function BotChat() {
  usePreventZoomTransitionDismissal();

  const { avatarTransition, botId } = useLocalSearchParams<{ avatarTransition?: string; botId: string }>();
  const { bots } = useMobileWorkspace();
  const { session } = useMobileSession();
  const foreground = useThemeColor("foreground");
  const resolvedBotId = Array.isArray(botId) ? botId[0] : botId;
  const resolvedAvatarTransition = Array.isArray(avatarTransition) ? avatarTransition[0] : avatarTransition;
  const animateAvatarOnExit = resolvedAvatarTransition === "search";
  const bot = bots.find((candidate) => candidate.id === resolvedBotId);
  const email = session?.user.email ?? "there";
  const userName = session?.user.name?.trim().split(/\s+/)[0] || email.split("@")[0] || "there";

  if (bot) {
    return (
      <>
        <Stack.Screen options={{ animation: animateAvatarOnExit ? "fade" : "slide_from_right" }} />
        <MobileChatView animateAvatarOnExit={animateAvatarOnExit} bot={bot} userName={userName} />
      </>
    );
  }

  return (
    <View className="flex-1 items-center justify-center gap-5 bg-background px-8">
      <Text className="text-center font-sans text-title font-semibold text-foreground">Bot unavailable</Text>
      <Text className="text-center font-sans text-body text-text-secondary">
        This bot is no longer available on the selected server.
      </Text>
      <Pressable
        accessibilityRole="button"
        className="min-h-12 flex-row items-center gap-2 rounded-full bg-control px-5"
        onPress={() => (router.canGoBack() ? router.back() : router.replace("/connected"))}
      >
        <ArrowLeft color={String(foreground)} size={20} strokeWidth={2} />
        <Text className="font-sans text-body font-semibold text-foreground">Go back</Text>
      </Pressable>
    </View>
  );
}
