import { Host, TextInput } from "@expo/ui";
import { useNativeState } from "@expo/ui/swift-ui";
import { useThemeColor } from "heroui-native/hooks";
import { Text, View } from "react-native";

import type { SheetFormFieldProps } from "@/components/sheet-form-field.types";

export function SheetFormField({
  autoCapitalize,
  autoCorrect,
  autoFocus,
  hint,
  inputMode,
  isRequired = false,
  label,
  maxLength,
  onChangeText,
  onSubmitEditing,
  placeholder,
  returnKeyType,
  value,
}: SheetFormFieldProps) {
  const [foreground, muted, surface, border] = useThemeColor(["foreground", "muted", "surface", "border"]);
  const nativeValue = useNativeState(value);

  return (
    <View className="gap-2">
      <Text className="font-sans text-label font-semibold text-foreground">
        {label}
        {isRequired ? " *" : ""}
      </Text>
      <View
        style={{
          backgroundColor: surface,
          borderColor: border,
          borderCurve: "continuous",
          borderRadius: 16,
          borderWidth: 1,
          height: 54,
          overflow: "hidden",
        }}
      >
        <Host ignoreSafeArea="all" style={{ height: 54 }}>
          <TextInput
            autoCapitalize={autoCapitalize}
            autoCorrect={autoCorrect}
            autoFocus={autoFocus}
            inputMode={inputMode}
            maxLength={maxLength}
            placeholder={placeholder}
            placeholderTextColor={muted}
            returnKeyType={returnKeyType}
            selectionColor={foreground}
            style={{ height: 54, paddingHorizontal: 16 }}
            textStyle={{ color: String(foreground), fontSize: 16 }}
            value={nativeValue}
            onChangeText={onChangeText}
            onSubmitEditing={onSubmitEditing}
          />
        </Host>
      </View>
      {hint ? (
        <View className="px-1">
          <Text className="font-sans text-caption leading-4 text-text-secondary">{hint}</Text>
        </View>
      ) : null}
    </View>
  );
}
