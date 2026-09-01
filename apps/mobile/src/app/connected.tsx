import { Button } from "heroui-native/button";
import { useThemeColor } from "heroui-native/hooks";
import { LogOut, Smartphone } from "lucide-react-native";
import { useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";

import { AppLogo } from "@/components/app-logo";
import { useMobileSession } from "@/providers/mobile-session-provider";

export default function Connected() {
  const [signingOut, setSigningOut] = useState(false);
  const foreground = useThemeColor("foreground");
  const { session, signOut: endSession } = useMobileSession();

  async function signOut(): Promise<void> {
    if (!session || signingOut) return;
    setSigningOut(true);
    try {
      await endSession();
    } finally {
      setSigningOut(false);
    }
  }

  if (!session) return null;

  const displayName = session.user.name?.trim() || session.user.email;

  return (
    <View className="flex-1 items-center justify-center bg-background px-6 pb-safe-offset-8 pt-safe-offset-8">
      <View className="w-full max-w-90 items-center">
        <AppLogo size={72} animation="blink" followDeviceOrientation interactive />
        <View className="mt-8 size-16 items-center justify-center rounded-3xl border border-border bg-control">
          <Smartphone size={28} color={foreground} strokeWidth={1.5} />
        </View>
        <Text
          accessibilityRole="header"
          className="mt-5 text-center font-sans text-heading font-semibold text-foreground"
        >
          Phone connected
        </Text>
        <Text className="mt-2 text-center font-sans text-body text-text-secondary">Signed in as {displayName}</Text>
        <Text className="mt-1 text-center font-sans text-caption text-muted">{session.user.email}</Text>

        <Button
          size="md"
          variant="secondary"
          className="mt-8 w-full rounded-xl border border-border"
          isDisabled={signingOut}
          onPress={() => void signOut()}
        >
          {signingOut ? <ActivityIndicator color={foreground} /> : <LogOut size={18} color={foreground} />}
          <Button.Label className="font-sans">{signingOut ? "Signing out…" : "Sign out"}</Button.Label>
        </Button>
      </View>
    </View>
  );
}
