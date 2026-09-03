import { router } from "expo-router";
import { Button, Typography } from "heroui-native";
import { Server } from "lucide-react-native";
import { useState } from "react";
import { Keyboard, Pressable, View } from "react-native";

import { AppLogo } from "@/features/auth/components/app-logo";
import { useMobileWorkspace } from "@/features/workspace/context/mobile-workspace-context";
import { SheetFormField } from "@/shared/components/sheet-form-field";
import { SheetScrollView } from "@/shared/components/sheet-scroll-view";

function normalizeInviteUrl(value: string): string | null {
  try {
    const invitation = new URL(value.trim());
    if (invitation.protocol !== "https:" && invitation.protocol !== "http:") return null;
    if (!invitation.hostname) return null;
    return invitation.toString();
  } catch {
    return null;
  }
}

export function AddServerScreen() {
  const { addRemoteServer } = useMobileWorkspace();
  const [inviteLink, setInviteLink] = useState("");
  const [reviewedInvite, setReviewedInvite] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canReview = inviteLink.trim().length > 0;

  function reviewInvite(): void {
    const normalizedInvite = normalizeInviteUrl(inviteLink);
    if (!normalizedInvite) {
      setError("Paste a valid invitation link.");
      return;
    }
    Keyboard.dismiss();
    setError(null);
    setReviewedInvite(normalizedInvite);
  }

  function joinServer(): void {
    if (!reviewedInvite) return;
    //! MOCK DATA RENDERED HERE
    addRemoteServer({ inviteUrl: reviewedInvite });
    router.back();
  }

  const invitationHost = reviewedInvite ? new URL(reviewedInvite).hostname : null;

  return (
    <SheetScrollView
      className="bg-background"
      contentContainerClassName="gap-7 px-5 pb-safe-offset-5 pt-14"
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      <View className="items-center gap-3 px-4">
        <AppLogo animation="blink" followDeviceOrientation interactive size={72} />
        <Typography.Heading type="h3" align="center" className="pt-1">
          Join a server
        </Typography.Heading>
        <Typography.Paragraph align="center" className="max-w-80 text-text-secondary">
          Paste the invitation you received from a server owner.
        </Typography.Paragraph>
      </View>

      {reviewedInvite ? (
        <View className="gap-5">
          <View className="flex-row items-center gap-3 rounded-3xl bg-control px-4 py-4">
            <View className="size-12 items-center justify-center rounded-2xl bg-accent">
              <Server color="#ffffff" size={23} strokeWidth={1.8} />
            </View>
            <View className="min-w-0 flex-1 gap-0.5">
              <Typography.Paragraph weight="semibold">Invitation ready</Typography.Paragraph>
              <Typography.Paragraph type="body-xs" className="text-text-secondary" numberOfLines={1} selectable>
                {invitationHost}
              </Typography.Paragraph>
            </View>
          </View>

          <Button size="lg" onPress={joinServer}>
            <Button.Label className="font-sans font-semibold">Join server</Button.Label>
          </Button>

          <Pressable
            accessibilityRole="button"
            className="min-h-11 items-center justify-center"
            onPress={() => setReviewedInvite(null)}
          >
            <Typography.Paragraph weight="semibold" className="text-text-secondary">
              Use another invitation
            </Typography.Paragraph>
          </Pressable>
        </View>
      ) : (
        <View className="gap-5">
          <SheetFormField
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            hint={error ?? undefined}
            inputMode="url"
            label="Invite link"
            maxLength={500}
            placeholder="https://openbot.run/join?…"
            returnKeyType="go"
            value={inviteLink}
            onChangeText={(value) => {
              setInviteLink(value);
              if (error) setError(null);
            }}
            onSubmitEditing={reviewInvite}
          />

          <Button size="lg" isDisabled={!canReview} onPress={reviewInvite}>
            <Button.Label className="font-sans font-semibold">Review invite</Button.Label>
          </Button>

          <Pressable
            accessibilityRole="button"
            className="min-h-11 items-center justify-center"
            onPress={() => router.back()}
          >
            <Typography.Paragraph weight="semibold" className="text-text-secondary">
              Cancel
            </Typography.Paragraph>
          </Pressable>
        </View>
      )}
    </SheetScrollView>
  );
}
