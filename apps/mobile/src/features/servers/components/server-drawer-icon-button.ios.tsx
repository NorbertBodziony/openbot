import { Host } from "@expo/ui";
import { Button, Image } from "@expo/ui/swift-ui";
import { accessibilityLabel, buttonBorderShape, buttonStyle, frame } from "@expo/ui/swift-ui/modifiers";
import { isLiquidGlassAvailable } from "expo-glass-effect";

import type { ServerDrawerIconButtonProps } from "./server-drawer-icon-button.types";

export function ServerDrawerIconButton({
  accessibilityLabel: label,
  color,
  systemName,
  onPress,
}: ServerDrawerIconButtonProps) {
  return (
    <Host ignoreSafeArea="all" style={{ height: 48, width: 48 }} useViewportSizeMeasurement>
      <Button
        onPress={onPress}
        modifiers={[
          frame({ height: 48, width: 48 }),
          buttonBorderShape("circle"),
          buttonStyle(isLiquidGlassAvailable() ? "glass" : "bordered"),
          accessibilityLabel(label),
        ]}
      >
        <Image color={color} size={18} systemName={systemName} />
      </Button>
    </Host>
  );
}
