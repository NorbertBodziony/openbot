import { router, Stack, useLocalSearchParams, usePreventZoomTransitionDismissal } from "expo-router";
import { Typography } from "heroui-native";
import { useThemeColor } from "heroui-native/hooks";
import { ArrowLeft } from "lucide-react-native";
import { Pressable, View } from "react-native";

import { MobileChatView } from "@/features/chat/components/chat-view";
import { useMobileWorkspace } from "@/features/workspace/context/mobile-workspace-context";

export function BotChatScreen() {
  usePreventZoomTransitionDismissal();

  const { avatarTransition, agentId } = useLocalSearchParams<{ avatarTransition?: string; agentId: string }>();
  const { bots } = useMobileWorkspace();
  const foreground = useThemeColor("foreground");
  const resolvedBotId = Array.isArray(agentId) ? agentId[0] : agentId;
  const resolvedAvatarTransition = Array.isArray(avatarTransition) ? avatarTransition[0] : avatarTransition;
  const animateAvatarOnExit = resolvedAvatarTransition === "search";
  const bot = bots.find((candidate) => candidate.id === resolvedBotId);

  if (bot) {
    return (
      <>
        <Stack.Screen options={{ animation: animateAvatarOnExit ? "fade" : "slide_from_right" }} />
        <MobileChatView animateAvatarOnExit={animateAvatarOnExit} bot={bot} />
      </>
    );
  }

  return (
    <View className="flex-1 items-center justify-center gap-5 bg-background px-8">
      <Typography.Heading type="h4" align="center">
        Bot unavailable
      </Typography.Heading>
      <Typography.Paragraph align="center" className="text-text-secondary">
        This bot is no longer available on the selected server.
      </Typography.Paragraph>
      <Pressable
        accessibilityRole="button"
        className="min-h-12 flex-row items-center gap-2 rounded-full bg-control px-5"
        onPress={() => (router.canGoBack() ? router.back() : router.replace("/connected"))}
      >
        <ArrowLeft color={String(foreground)} size={20} strokeWidth={2} />
        <Typography.Paragraph weight="semibold">Go back</Typography.Paragraph>
      </Pressable>
    </View>
  );
}
