import { Input, TextField } from "heroui-native";
import { Text, View } from "react-native";

import type { SheetFormFieldProps } from "@/components/sheet-form-field.types";

export function SheetFormField({ hint, isRequired = false, label, ...inputProps }: SheetFormFieldProps) {
  return (
    <TextField isRequired={isRequired}>
      <Text className="font-sans text-label font-semibold text-foreground">{label}</Text>
      <Input
        accessibilityLabel={label}
        className="min-h-12 rounded-2xl px-4 font-sans text-body"
        variant="primary"
        {...inputProps}
      />
      {hint ? (
        <View className="px-1">
          <Text className="font-sans text-caption leading-4 text-text-secondary">{hint}</Text>
        </View>
      ) : null}
    </TextField>
  );
}
