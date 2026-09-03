import { Pressable } from "react-native";

import type { ServerDrawerIconButtonProps } from "./server-drawer-icon-button.types";

export function ServerDrawerIconButton({
  accessibilityLabel,
  children,
  fallbackVariant = "plain",
  onPress,
}: ServerDrawerIconButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      className={
        fallbackVariant === "filled"
          ? "size-9 items-center justify-center rounded-full bg-control"
          : "size-10 items-center justify-center rounded-full"
      }
      hitSlop={fallbackVariant === "filled" ? 6 : 8}
      onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.58 : 1 })}
    >
      {children}
    </Pressable>
  );
}
