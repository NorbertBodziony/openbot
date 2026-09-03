import { Host } from "@expo/ui";
import { FilledTonalButton, Text } from "@expo/ui/jetpack-compose";
import { fillMaxWidth, height } from "@expo/ui/jetpack-compose/modifiers";
import { useCSSVariable } from "uniwind";

import type { ScanQrButtonProps } from "@/features/auth/components/scan-qr-button.types";

export function ScanQrButton({ onPress }: ScanQrButtonProps) {
  const brandColor = String(useCSSVariable("--openbot-logo-production") ?? "#cdadec");
  const labelColor = String(useCSSVariable("--openbot-logo-eye") ?? "#040007");

  return (
    <Host ignoreSafeArea="all" seedColor={brandColor} style={{ height: 60, width: "100%" }} useViewportSizeMeasurement>
      <FilledTonalButton
        colors={{ containerColor: brandColor, contentColor: labelColor }}
        modifiers={[fillMaxWidth(), height(60)]}
        onClick={onPress}
      >
        <Text color={labelColor} style={{ fontSize: 16, fontWeight: "600", typography: "labelLarge" }}>
          Scan QR code
        </Text>
      </FilledTonalButton>
    </Host>
  );
}
