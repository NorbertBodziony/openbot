import { Typography } from "heroui-native";
import { View } from "react-native";

import { AnimatedCounter } from "@/features/workspace/components/connection-counter";
import { ConnectionStatusReveal } from "@/features/workspace/components/connection-status-reveal";

export function ConnectionCountdown({ seconds }: { seconds: number | null }) {
  return (
    <ConnectionStatusReveal value={seconds}>
      {(remaining) => {
        const minutes = Math.floor(remaining / 60);
        const digits = String(remaining % 60).padStart(2, "0");
        return (
          <View className="flex-row items-center">
            <Typography.Paragraph type="body-xs" className="text-text-secondary" maxFontSizeMultiplier={1.2}>
              {" · "}
            </Typography.Paragraph>
            <AnimatedCounter value={String(minutes)} />
            <Typography.Paragraph type="body-xs" className="text-text-secondary" maxFontSizeMultiplier={1.2}>
              :
            </Typography.Paragraph>
            <AnimatedCounter value={digits.slice(0, 1)} />
            <AnimatedCounter value={digits.slice(1)} />
          </View>
        );
      }}
    </ConnectionStatusReveal>
  );
}
