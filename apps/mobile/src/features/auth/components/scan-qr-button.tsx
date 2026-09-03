import { Button } from "heroui-native";
import { useCSSVariable } from "uniwind";

import type { ScanQrButtonProps } from "@/features/auth/components/scan-qr-button.types";

export function ScanQrButton({ onPress }: ScanQrButtonProps) {
  const brandColor = String(useCSSVariable("--openbot-logo-production") ?? "#cdadec");
  const labelColor = String(useCSSVariable("--openbot-logo-eye") ?? "#040007");

  return (
    <Button
      size="lg"
      variant="primary"
      className="h-15 w-full"
      accessibilityLabel="Scan QR code"
      style={{ backgroundColor: brandColor }}
      onPress={onPress}
    >
      <Button.Label className="font-sans font-semibold" style={{ color: labelColor }}>
        Scan QR code
      </Button.Label>
    </Button>
  );
}
