import { type PropsWithChildren, useEffect, useRef } from "react";
import { View } from "react-native";

import { type AgentAvatarLocation, useAgentPinTransition } from "@/features/agents/components/agent-pin-transition";

interface AgentPinAvatarProps extends PropsWithChildren {
  agentId: string;
  location: AgentAvatarLocation;
  size: number;
}

export function AgentPinAvatar({ agentId, children, location, size }: AgentPinAvatarProps) {
  const ref = useRef<View>(null);
  const { notifyAvatarLayout, registerAvatar, transition } = useAgentPinTransition();

  useEffect(() => {
    registerAvatar(agentId, location, ref.current);
    return () => registerAvatar(agentId, location, null);
  }, [agentId, location, registerAvatar]);

  const hidden = transition?.agentId === agentId && (transition.source === location || transition.target === location);

  return (
    <View
      ref={ref}
      collapsable={false}
      onLayout={() => notifyAvatarLayout(agentId, location)}
      style={{ height: size, opacity: hidden ? 0 : 1, width: size }}
    >
      {children}
    </View>
  );
}
