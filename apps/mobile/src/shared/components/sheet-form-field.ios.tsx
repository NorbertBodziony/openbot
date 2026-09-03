import { Host, TextInput } from "@expo/ui";
import { useNativeState } from "@expo/ui/swift-ui";
import { Typography } from "heroui-native";
import { useThemeColor } from "heroui-native/hooks";
import { View } from "react-native";

import type { SheetFormFieldProps } from "@/shared/components/sheet-form-field.types";

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
      <Typography type="body-sm" weight="semibold">
        {label}
        {isRequired ? " *" : ""}
      </Typography>
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
          <Typography.Paragraph type="body-xs" className="text-text-secondary">
            {hint}
          </Typography.Paragraph>
        </View>
      ) : null}
    </View>
  );
}
