import { router } from "expo-router";
import { useIsFocused } from "expo-router/react-navigation";
import { Typography } from "heroui-native";
import { View } from "react-native";

import { AppLogo } from "@/features/auth/components/app-logo";
import { PixelBlastBackground } from "@/features/auth/components/pixel-blast-background";
import { ScanQrButton } from "@/features/auth/components/scan-qr-button";

export function SignInScreen() {
  const isFocused = useIsFocused();

  return (
    <View className="min-h-full flex-1 grow items-center justify-center overflow-hidden bg-background px-6 pb-safe-offset-8 pt-safe-offset-8">
      <PixelBlastBackground active={isFocused} />
      <View className="z-10 w-full max-w-90">
        <View className="mb-10.5 items-center justify-center gap-6">
          <AppLogo
            size={80}
            animation={isFocused ? "blink" : "none"}
            followDeviceOrientation={isFocused}
            interactive={isFocused}
          />
          <Typography.Heading type="h1" align="center" className="tracking-openbot-tight">
            OpenBot
          </Typography.Heading>
        </View>

        <View className="items-center gap-2">
          <Typography.Heading type="h2" align="center" className="tracking-openbot-tight">
            Sign in to OpenBot
          </Typography.Heading>
          <Typography.Paragraph color="muted" align="center">
            Scan the QR code on your OpenBot device to sign in and start controlling it.
          </Typography.Paragraph>
        </View>

        <View className="mt-6">
          <ScanQrButton onPress={() => router.push("/scan-qr-code")} />
        </View>
      </View>
    </View>
  );
}
