import { Link } from "expo-router";
import { useIsFocused } from "expo-router/react-navigation";
import { Button } from "heroui-native/button";
import { Text, View } from "react-native";

import { AppLogo } from "@/components/app-logo";

export default function Index() {
  const isFocused = useIsFocused();

  return (
    <View className="flex-1 bg-background min-h-full grow items-center justify-center px-6">
      <View className="w-full max-w-90">
        <View className="mb-10.5 flex-col items-center justify-center gap-6">
          <AppLogo
            size={80}
            animation={isFocused ? "blink" : "none"}
            followDeviceOrientation={isFocused}
            interactive={isFocused}
          />
          <Text className="font-sans text-display font-semibold tracking-openbot-tight text-foreground">OpenBot</Text>
        </View>

        <View className="items-center">
          <Text
            accessibilityRole="header"
            className="font-sans text-heading font-semibold tracking-openbot-tight text-foreground"
          >
            Sign in to OpenBot
          </Text>
          <Text className="mt-2 text-center font-sans text-[14px] leading-5.25 text-text-secondary">
            Scan the QR code on your OpenBot device to sign in and start controlling it.
          </Text>
        </View>

        <View className="mt-6 gap-3">
          <Link href="./scan-qr-code" asChild>
            <Button
              size="md"
              variant="secondary"
              className="w-full rounded-xl border border-border bg-action"
              accessibilityLabel="Scan QR code"
            >
              <Button.Label className="font-sans font-semibold text-action-foreground">Scan QR code</Button.Label>
            </Button>
          </Link>
        </View>
      </View>
    </View>
  );
}
