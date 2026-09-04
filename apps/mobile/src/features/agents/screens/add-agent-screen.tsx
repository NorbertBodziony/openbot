import * as Crypto from "expo-crypto";
import { router } from "expo-router";
import { Button, Typography } from "heroui-native";
import { useState } from "react";
import { View } from "react-native";

import { useMobileWorkspace } from "@/features/workspace/context/mobile-workspace-context";
import { SheetFormField } from "@/shared/components/sheet-form-field";
import { SheetScrollView } from "@/shared/components/sheet-scroll-view";

export function AddAgentScreen() {
  const { createAgent } = useMobileWorkspace();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [initialMessage, setInitialMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = name.trim().length > 0 && description.trim().length > 0 && initialMessage.trim().length > 0;

  async function submit(): Promise<void> {
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    try {
      await createAgent({
        name: name.trim(),
        description: description.trim(),
        initialMessage: initialMessage.trim(),
        avatarSeed: `mobile:${Crypto.randomUUID().replaceAll("-", "")}`,
        avatarHue: null,
      });
      router.back();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "OpenBot could not create this agent.");
      setSaving(false);
    }
  }

  return (
    <SheetScrollView
      className="bg-background"
      contentContainerClassName="gap-5 px-5 pb-safe-offset-5 pt-5"
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
    >
      <View className="gap-1">
        <Typography.Heading type="h4">Create an agent</Typography.Heading>
        <Typography.Paragraph className="text-text-secondary">
          It will be created on the selected OpenBot server and appear on every connected device.
        </Typography.Paragraph>
      </View>

      <SheetFormField
        autoCapitalize="words"
        autoFocus
        label="Name"
        maxLength={80}
        placeholder="Research partner"
        value={name}
        onChangeText={setName}
      />
      <SheetFormField
        label="Role"
        maxLength={240}
        placeholder="What should this agent be good at?"
        value={description}
        onChangeText={setDescription}
      />
      <SheetFormField
        label="First task"
        maxLength={4_000}
        placeholder="Tell the agent what to work on first"
        value={initialMessage}
        onChangeText={setInitialMessage}
      />

      {error ? (
        <Typography.Paragraph align="center" className="text-danger">
          {error}
        </Typography.Paragraph>
      ) : null}

      <Button size="lg" isDisabled={!valid || saving} onPress={() => void submit()}>
        <Button.Label className="font-sans font-semibold">{saving ? "Creating…" : "Create agent"}</Button.Label>
      </Button>
    </SheetScrollView>
  );
}
