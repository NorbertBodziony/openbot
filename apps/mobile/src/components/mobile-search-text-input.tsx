import { useThemeColor } from "heroui-native/hooks";
import { TextInput } from "react-native";

import type { MobileSearchTextInputProps } from "@/components/mobile-search-text-input.types";

export function MobileSearchTextInput({ value, onChangeText }: MobileSearchTextInputProps) {
  const [foreground, muted] = useThemeColor(["foreground", "muted"]);

  return (
    <TextInput
      accessibilityLabel="Search"
      autoCapitalize="none"
      autoCorrect={false}
      autoFocus
      className="h-8 min-w-0 flex-1 font-sans text-foreground"
      placeholder="Search"
      placeholderTextColor={muted}
      returnKeyType="search"
      selectionColor={foreground}
      style={{ fontSize: 16, lineHeight: 20, paddingBottom: 0, paddingTop: 0, textAlignVertical: "center" }}
      value={value}
      onChangeText={onChangeText}
    />
  );
}
