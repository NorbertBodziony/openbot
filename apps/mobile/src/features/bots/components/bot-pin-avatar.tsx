import { type PropsWithChildren, useEffect, useRef } from "react";
import { View } from "react-native";

import { type BotAvatarLocation, useBotPinTransition } from "@/features/bots/components/bot-pin-transition";

interface BotPinAvatarProps extends PropsWithChildren {
  botId: string;
  location: BotAvatarLocation;
  size: number;
}

export function BotPinAvatar({ botId, children, location, size }: BotPinAvatarProps) {
  const ref = useRef<View>(null);
  const { notifyAvatarLayout, registerAvatar, transition } = useBotPinTransition();

  useEffect(() => {
    registerAvatar(botId, location, ref.current);
    return () => registerAvatar(botId, location, null);
  }, [botId, location, registerAvatar]);

  const hidden = transition?.botId === botId && (transition.source === location || transition.target === location);

  return (
    <View
      ref={ref}
      collapsable={false}
      onLayout={() => notifyAvatarLayout(botId, location)}
      style={{ height: size, opacity: hidden ? 0 : 1, width: size }}
    >
      {children}
    </View>
  );
}
