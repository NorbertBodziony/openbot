import { Link } from "expo-router";
import { Pressable, Text, View } from "react-native";

import { BloubAvatar } from "@/components/bloub-avatar";
import type { MobileBot } from "@/providers/mobile-workspace-provider";

interface BotListRowProps {
  bot: MobileBot;
  enableZoomTransition?: boolean;
}

export function BotListRow({ bot, enableZoomTransition = true }: BotListRowProps) {
  const avatar = (
    <View style={{ height: 54, width: 54 }}>
      <BloubAvatar seed={bot.avatarSeed} size={54} />
    </View>
  );

  return (
    <Link href={{ pathname: "/chat/[botId]", params: { botId: bot.id } }} asChild>
      <Link.Trigger>
        <Pressable
          accessibilityLabel={`Open chat with ${bot.name}`}
          accessibilityRole="button"
          className="min-h-20 flex-row items-center gap-3 px-5 py-3"
          style={({ pressed }) => ({ opacity: pressed ? 0.58 : 1 })}
        >
          {enableZoomTransition ? <Link.AppleZoom>{avatar}</Link.AppleZoom> : avatar}
          <View className="min-w-0 flex-1 gap-1">
            <View className="flex-row items-baseline gap-2">
              <Text className="min-w-0 flex-1 font-sans text-body font-semibold text-foreground" numberOfLines={1}>
                {bot.name}
              </Text>
              <Text className="font-sans text-caption text-text-dim">{bot.updatedLabel}</Text>
            </View>
            <Text className="font-sans text-caption leading-5 text-text-secondary" numberOfLines={1}>
              {bot.preview}
            </Text>
          </View>
        </Pressable>
      </Link.Trigger>
    </Link>
  );
}
