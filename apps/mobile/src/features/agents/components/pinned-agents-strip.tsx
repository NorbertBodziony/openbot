import * as Haptics from "expo-haptics";
import { Link } from "expo-router";
import { Typography } from "heroui-native";
import { useThemeColor } from "heroui-native/hooks";
import { Pressable, ScrollView, View } from "react-native";
import Animated, {
  CurvedTransition,
  Easing,
  FadeIn,
  FadeOut,
  LinearTransition,
  ReduceMotion,
} from "react-native-reanimated";
import { useAgentContextMenu } from "@/features/agents/components/agent-context-menu";
import { AgentPinAvatar } from "@/features/agents/components/agent-pin-avatar";
import { BloubAvatar } from "@/features/agents/components/bloub-avatar";
import { type MobileAgent, useMobileWorkspace } from "@/features/workspace/context/mobile-workspace-context";
import { isIOS } from "@/shared/lib/platform";

const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);
const EASE_IN_OUT = Easing.bezier(0.77, 0, 0.175, 1);
const PINNED_LAYOUT = LinearTransition.duration(220).easing(EASE_IN_OUT).reduceMotion(ReduceMotion.System);
const PINNED_ITEM_LAYOUT = CurvedTransition.duration(240)
  .easingX(EASE_IN_OUT)
  .easingY(EASE_IN_OUT)
  .reduceMotion(ReduceMotion.System);
const PINNED_ENTER = FadeIn.duration(180).easing(EASE_OUT).reduceMotion(ReduceMotion.System);
const PINNED_EXIT = FadeOut.duration(140).easing(EASE_OUT).reduceMotion(ReduceMotion.System);

export function PinnedAgentsStrip({ agents }: { agents: MobileAgent[] }) {
  return (
    <Animated.View layout={PINNED_LAYOUT}>
      {agents.length > 0 ? (
        <Animated.View exiting={PINNED_EXIT} style={{ width: "100%" }}>
          <ScrollView
            horizontal
            contentContainerStyle={{
              alignItems: "flex-start",
              flexGrow: 1,
              gap: 18,
              justifyContent: "center",
              paddingHorizontal: 20,
              paddingVertical: 22,
            }}
            showsHorizontalScrollIndicator={false}
          >
            {agents.map((agent) => (
              <PinnedAgentItem key={agent.id} agent={agent} />
            ))}
          </ScrollView>
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

function PinnedAgentItem({ agent }: { agent: MobileAgent }) {
  const [background, accent] = useThemeColor(["background", "accent"]);
  const { unreadAgentIds } = useMobileWorkspace();
  const agentContextMenu = useAgentContextMenu(agent);
  const isUnread = unreadAgentIds.includes(agent.id);

  const handleOpen = () => {
    if (isIOS) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft);
  };

  return (
    <Animated.View entering={PINNED_ENTER} exiting={PINNED_EXIT} layout={PINNED_ITEM_LAYOUT}>
      <Link href={{ pathname: "/chat/[agentId]", params: { agentId: agent.id } }} asChild onPress={handleOpen}>
        <Link.Trigger>
          <Pressable
            accessibilityLabel={`Open pinned chat with ${agent.name}`}
            accessibilityRole="button"
            className="w-20 items-center gap-2"
            style={({ pressed }) => ({ opacity: pressed ? 0.58 : 1 })}
          >
            <Link.AppleZoom>
              <AgentPinAvatar agentId={agent.id} location="pinned" size={76}>
                <BloubAvatar hue={agent.avatarHue} seed={agent.avatarSeed} size={76} />
                {isUnread ? (
                  <View
                    className="absolute right-0 top-0 size-3.5 rounded-full border-2 bg-accent"
                    style={{ borderColor: background, backgroundColor: accent }}
                  />
                ) : null}
              </AgentPinAvatar>
            </Link.AppleZoom>
            <Typography.Paragraph
              type="body-xs"
              align="center"
              className="w-full text-text-secondary"
              numberOfLines={1}
            >
              {agent.name}
            </Typography.Paragraph>
          </Pressable>
        </Link.Trigger>
        {agentContextMenu}
      </Link>
    </Animated.View>
  );
}
