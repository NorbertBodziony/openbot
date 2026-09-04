import { GlassView } from "expo-glass-effect";
import { Link } from "expo-router";
import { Typography } from "heroui-native";
import { ArrowLeft, Monitor } from "lucide-react-native";
import { Alert, View, type ViewStyle } from "react-native";
import { AgentPinAvatar } from "@/features/agents/components/agent-pin-avatar";
import { BloubAvatar } from "@/features/agents/components/bloub-avatar";
import { ChatGlassIconButton } from "@/features/chat/components/chat-glass-icon-button";
import type { MobileAgent } from "@/features/workspace/context/mobile-workspace-context";
import { SheetScrollEdgeEffect } from "@/shared/components/sheet-scroll-edge-effect";

interface ChatHeaderProps {
  agent: MobileAgent;
  fallbackBackground: ViewStyle["backgroundColor"];
  foreground: ViewStyle["backgroundColor"];
  liquidGlassAvailable: boolean;
  topInset: number;
  onBack: () => void;
}

export function ChatHeader({
  agent,
  fallbackBackground,
  foreground,
  liquidGlassAvailable,
  topInset,
  onBack,
}: ChatHeaderProps) {
  const iconColor = String(foreground);

  return (
    <>
      <View
        className="absolute inset-x-0 z-20 flex-row items-center gap-2 px-4"
        pointerEvents="box-none"
        style={{ top: topInset + 8 }}
      >
        <ChatGlassIconButton
          accessibilityLabel="Back"
          fallbackBackground={fallbackBackground}
          liquidGlassAvailable={liquidGlassAvailable}
          onPress={onBack}
        >
          <ArrowLeft color={iconColor} size={24} strokeWidth={2} />
        </ChatGlassIconButton>

        <GlassView
          glassEffectStyle={liquidGlassAvailable ? "regular" : "none"}
          style={{
            alignItems: "center",
            alignSelf: "stretch",
            backgroundColor: liquidGlassAvailable ? "transparent" : fallbackBackground,
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
            <AgentPinAvatar agentId={agent.id} location="chat" size={28}>
              <BloubAvatar hue={agent.avatarHue} seed={agent.avatarSeed} size={28} />
            </AgentPinAvatar>
          </Link.AppleZoomTarget>
          <Typography.Paragraph className="min-w-0 shrink" weight="semibold" numberOfLines={1}>
            {agent.name}
          </Typography.Paragraph>
        </GlassView>

        <View className="flex-1" />

        <ChatGlassIconButton
          accessibilityLabel="Open on desktop"
          fallbackBackground={fallbackBackground}
          liquidGlassAvailable={liquidGlassAvailable}
          onPress={() => Alert.alert("Open on desktop", "Desktop handoff will be connected with the server API.")}
        >
          <Monitor color={iconColor} size={22} strokeWidth={1.9} />
        </ChatGlassIconButton>
      </View>
      <SheetScrollEdgeEffect
        style={{ height: topInset + 82, left: 0, position: "absolute", right: 0, top: 0, zIndex: 10 }}
      />
    </>
  );
}
