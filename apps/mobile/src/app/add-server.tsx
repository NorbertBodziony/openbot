import { router } from "expo-router";
import { Button } from "heroui-native";
import { Server } from "lucide-react-native";
import { useState } from "react";
import { Keyboard, Pressable, Text, View } from "react-native";

import { AppLogo } from "@/components/app-logo";
import { SheetFormField } from "@/components/sheet-form-field";
import { SheetScrollView } from "@/components/sheet-scroll-view";
import { useMobileWorkspace } from "@/providers/mobile-workspace-provider";

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

export default function AddServer() {
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
        <Text className="pt-1 text-center font-sans text-heading font-semibold text-foreground">Join a server</Text>
        <Text className="max-w-80 text-center font-sans text-body text-text-secondary">
          Paste the invitation you received from a server owner.
        </Text>
      </View>

      {reviewedInvite ? (
        <View className="gap-5">
          <View className="flex-row items-center gap-3 rounded-3xl bg-control px-4 py-4">
            <View className="size-12 items-center justify-center rounded-2xl bg-accent">
              <Server color="#ffffff" size={23} strokeWidth={1.8} />
            </View>
            <View className="min-w-0 flex-1 gap-0.5">
              <Text className="font-sans text-body font-semibold text-foreground">Invitation ready</Text>
              <Text className="font-sans text-caption text-text-secondary" numberOfLines={1} selectable>
                {invitationHost}
              </Text>
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
            <Text className="font-sans text-body font-semibold text-text-secondary">Use another invitation</Text>
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
            <Text className="font-sans text-body font-semibold text-text-secondary">Cancel</Text>
          </Pressable>
        </View>
      )}
    </SheetScrollView>
  );
}
