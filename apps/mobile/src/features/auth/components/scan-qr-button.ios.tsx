import { Host } from "@expo/ui";
import { Button } from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  bold,
  buttonBorderShape,
  buttonStyle,
  containerRelativeFrame,
  controlSize,
  frame,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import { isLiquidGlassAvailable } from "expo-glass-effect";
import { useCSSVariable } from "uniwind";

import type { ScanQrButtonProps } from "@/features/auth/components/scan-qr-button.types";

export function ScanQrButton({ onPress }: ScanQrButtonProps) {
  const brandColor = String(useCSSVariable("--openbot-logo-production") ?? "#cdadec");

  return (
    <Host ignoreSafeArea="all" seedColor={brandColor} style={{ height: 64, width: "100%" }} useViewportSizeMeasurement>
      <Button
        label="Scan QR code"
        modifiers={[
          containerRelativeFrame({ axes: "horizontal" }),
          frame({ height: 64 }),
          buttonBorderShape("capsule"),
          buttonStyle(isLiquidGlassAvailable() ? "glass" : "bordered"),
          controlSize("large"),
          tint(brandColor),
          bold(),
          accessibilityLabel("Scan QR code"),
        ]}
        onPress={onPress}
      />
    </Host>
  );
}
