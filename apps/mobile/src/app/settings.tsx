import { Button, Spinner, Typography } from "heroui-native";
import { useThemeColor } from "heroui-native/hooks";
import { LogOut } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";

import { ProfileAvatar } from "@/components/profile-avatar";
import { SheetScrollView } from "@/components/sheet-scroll-view";
import { useMobileSession } from "@/providers/mobile-session-provider";

export default function Settings() {
  const { session, signOut } = useMobileSession();
  const [signingOut, setSigningOut] = useState(false);
  const dangerSoftForeground = useThemeColor("danger-soft-foreground");

  if (!session) return null;

  const displayName = session.user.name?.trim() || session.user.email;

  async function submitSignOut(): Promise<void> {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <SheetScrollView contentContainerClassName="gap-8 px-5 pb-safe-offset-5 pt-7">
      <View className="gap-3">
        <Typography
          type="body-sm"
          weight="semibold"
          className="px-1 uppercase tracking-openbot-wide text-text-secondary"
        >
          Account
        </Typography>
        <View className="flex-row items-center gap-3 rounded-3xl bg-control px-4 py-4">
          <ProfileAvatar name={displayName} imageUrl={session.user.avatarUrl} size={52} />
          <View className="min-w-0 flex-1 gap-0.5">
            <Typography.Paragraph weight="semibold" numberOfLines={1}>
              {displayName}
            </Typography.Paragraph>
            <Typography.Paragraph type="body-xs" className="text-text-secondary" numberOfLines={1} selectable>
              {session.user.email}
            </Typography.Paragraph>
          </View>
        </View>
      </View>

      <Button variant="danger-soft" size="lg" isDisabled={signingOut} onPress={() => void submitSignOut()}>
        {signingOut ? (
          <Spinner size="sm" color={String(dangerSoftForeground)} />
        ) : (
          <LogOut color={String(dangerSoftForeground)} size={19} strokeWidth={2} />
        )}
        <Button.Label className="font-sans font-semibold">{signingOut ? "Signing out…" : "Sign out"}</Button.Label>
      </Button>
    </SheetScrollView>
  );
}
