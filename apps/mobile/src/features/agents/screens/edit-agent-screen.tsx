import { router, useLocalSearchParams } from "expo-router";
import { Button, Typography } from "heroui-native";
import { useState } from "react";
import { View } from "react-native";

import { useMobileWorkspace } from "@/features/workspace/context/mobile-workspace-context";
import { SheetFormField } from "@/shared/components/sheet-form-field";
import { SheetScrollView } from "@/shared/components/sheet-scroll-view";

export function EditBotScreen() {
  const { agentId } = useLocalSearchParams<{ agentId: string }>();
  const resolvedBotId = Array.isArray(agentId) ? agentId[0] : agentId;
  const { bots, updateBot } = useMobileWorkspace();
  const bot = bots.find((candidate) => candidate.id === resolvedBotId);
  const [name, setName] = useState(bot?.name ?? "");
  const [description, setDescription] = useState(bot?.description ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = Boolean(bot && name.trim() && description.trim());

  async function submit(): Promise<void> {
    if (!bot || !valid || saving) return;
    setSaving(true);
    setError(null);
    try {
      await updateBot({ botId: bot.id, name: name.trim(), description: description.trim() });
      router.back();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "OpenBot could not update this bot.");
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
      {bot ? (
        <>
          <View className="gap-1">
            <Typography.Heading type="h4">Edit {bot.name}</Typography.Heading>
            <Typography.Paragraph className="text-text-secondary">
              Changes are saved on the desktop server and sent live to connected devices.
            </Typography.Paragraph>
          </View>
          <SheetFormField
            autoCapitalize="words"
            autoFocus
            label="Name"
            maxLength={80}
            value={name}
            onChangeText={setName}
          />
          <SheetFormField label="Role" maxLength={240} value={description} onChangeText={setDescription} />
          {error ? (
            <Typography.Paragraph align="center" className="text-danger">
              {error}
            </Typography.Paragraph>
          ) : null}
          <Button size="lg" isDisabled={!valid || saving} onPress={() => void submit()}>
            <Button.Label className="font-sans font-semibold">{saving ? "Saving…" : "Save changes"}</Button.Label>
          </Button>
        </>
      ) : (
        <Typography.Paragraph align="center" className="text-text-secondary">
          This bot is no longer available on the selected server.
        </Typography.Paragraph>
      )}
    </SheetScrollView>
  );
}
