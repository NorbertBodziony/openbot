import { GlassView } from "expo-glass-effect";
import type { PropsWithChildren } from "react";
import { Pressable, type ViewStyle } from "react-native";

interface ChatGlassIconButtonProps extends PropsWithChildren {
  accessibilityLabel: string;
  fallbackBackground: ViewStyle["backgroundColor"];
  liquidGlassAvailable: boolean;
  onPress: () => void;
}

export function ChatGlassIconButton({
  accessibilityLabel,
  children,
  fallbackBackground,
  liquidGlassAvailable,
  onPress,
}: ChatGlassIconButtonProps) {
  return (
    <GlassView
      glassEffectStyle={liquidGlassAvailable ? "regular" : "none"}
      isInteractive={liquidGlassAvailable}
      style={{
        backgroundColor: liquidGlassAvailable ? "transparent" : fallbackBackground,
        borderCurve: "continuous",
        borderRadius: 24,
        height: 48,
        overflow: "hidden",
        width: 48,
      }}
    >
      <Pressable
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="button"
        className="flex-1 items-center justify-center"
        hitSlop={4}
        style={({ pressed }) => ({ opacity: pressed ? 0.55 : 1 })}
        onPress={onPress}
      >
        {children}
      </Pressable>
    </GlassView>
  );
}
