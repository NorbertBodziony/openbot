import { Stack } from "expo-router";
import { Typography } from "heroui-native";
import { useState } from "react";
import { View } from "react-native";

import { AppLogo } from "@/components/app-logo";
import { useMobileSession } from "@/providers/mobile-session-provider";

export default function Connected() {
  const [signingOut, setSigningOut] = useState(false);
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
    <>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button disabled={signingOut} onPress={() => void signOut()}>
          {signingOut ? "Signing out…" : "Sign out"}
        </Stack.Toolbar.Button>
      </Stack.Toolbar>

      <View className="flex-1 items-center justify-center bg-background px-6 pb-safe-offset-8 pt-8">
        <View className="w-full max-w-90 items-center">
          <AppLogo size={72} animation="blink" followDeviceOrientation interactive />

          <Typography.Heading type="h2" align="center" className="mt-5 tracking-openbot-tight">
            Phone connected
          </Typography.Heading>
          <Typography.Paragraph color="muted" align="center" className="mt-2">
            Signed in as {displayName}
          </Typography.Paragraph>
          {displayName !== session.user.email ? (
            <Typography type="body-xs" color="muted" align="center" selectable className="mt-1">
              {session.user.email}
            </Typography>
          ) : null}
        </View>
      </View>
    </>
  );
}
