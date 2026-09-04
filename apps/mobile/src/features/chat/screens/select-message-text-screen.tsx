import { router, useLocalSearchParams } from "expo-router";
import { Stack } from "expo-router/stack";
import { Button, Typography } from "heroui-native";
import { useThemeColor } from "heroui-native/hooks";
import { useState } from "react";
import { ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useMobileWorkspace } from "@/features/workspace/context/mobile-workspace-context";
import { isIOS } from "@/shared/lib/platform";

export function SelectMessageTextScreen() {
  const { botId, messageId } = useLocalSearchParams<{ botId: string; messageId: string }>();
  const { conversations } = useMobileWorkspace();
  const [foreground, accent] = useThemeColor(["foreground", "accent"]);
  const insets = useSafeAreaInsets();
  // Freeze the text so incoming stream updates cannot move the selection handles.
  const [body] = useState(() => conversations[botId]?.messages.find((message) => message.id === messageId)?.text);
  const close = () => (router.canGoBack() ? router.back() : router.replace("/connected"));

  return (
    <View className="flex-1 bg-background" style={{ paddingBottom: insets.bottom }}>
      {isIOS ? (
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Button onPress={close}>Done</Stack.Toolbar.Button>
        </Stack.Toolbar>
      ) : (
        <Stack.Screen
          options={{
            headerRight: () => (
              <Button variant="ghost" onPress={close}>
                <Button.Label>Done</Button.Label>
              </Button>
            ),
          }}
        />
      )}
      {body === undefined ? (
        <Typography className="p-5 text-muted">This message is no longer available.</Typography>
      ) : isIOS ? (
        // Unlike Expo UI's disabled SwiftUI TextField, UITextView retains range selection when read-only.
        <TextInput
          accessibilityLabel="Message text"
          accessibilityHint="Touch and hold to select and copy any part of the message."
          multiline
          readOnly
          showSoftInputOnFocus={false}
          autoCorrect={false}
          spellCheck={false}
          className="flex-1 font-sans"
          style={{ color: foreground, fontSize: 16, lineHeight: 26, padding: 20, textAlignVertical: "top" }}
          selectionColor={accent}
          value={body}
        />
      ) : (
        <ScrollView className="flex-1" contentContainerStyle={{ padding: 20 }}>
          <Typography selectable>{body}</Typography>
        </ScrollView>
      )}
    </View>
  );
}
