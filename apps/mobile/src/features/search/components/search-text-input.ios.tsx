import { Host, TextInput } from "@expo/ui";
import { useNativeState } from "@expo/ui/swift-ui";
import { useThemeColor } from "heroui-native/hooks";
import { CircleX } from "lucide-react-native";
import { Pressable, View } from "react-native";

import type { MobileSearchTextInputProps } from "@/features/search/components/search-text-input.types";

export function MobileSearchTextInput({ value, onChangeText }: MobileSearchTextInputProps) {
  const [foreground, muted, background] = useThemeColor(["foreground", "muted", "background"]);
  const nativeValue = useNativeState(value);
  const clear = () => {
    nativeValue.set("");
    onChangeText("");
  };

  return (
    <View className="h-8 min-w-0 flex-1 flex-row items-center">
      <Host ignoreSafeArea="all" style={{ flex: 1, height: 32 }}>
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          placeholder="Search"
          placeholderTextColor={muted}
          returnKeyType="search"
          selectionColor={foreground}
          style={{ height: 32 }}
          textStyle={{ color: String(foreground), fontSize: 16 }}
          value={nativeValue}
          onChangeText={onChangeText}
        />
      </Host>
      {value ? (
        <Pressable
          accessibilityLabel="Clear search"
          accessibilityRole="button"
          className="size-8 items-center justify-center"
          hitSlop={6}
          onPress={clear}
        >
          <CircleX color={String(background)} fill={String(muted)} size={18} strokeWidth={2} />
        </Pressable>
      ) : null}
    </View>
  );
}
