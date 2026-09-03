import { Input, TextField, Typography } from "heroui-native";
import { View } from "react-native";

import type { SheetFormFieldProps } from "@/shared/components/sheet-form-field.types";

export function SheetFormField({ hint, isRequired = false, label, ...inputProps }: SheetFormFieldProps) {
  return (
    <TextField isRequired={isRequired}>
      <Typography type="body-sm" weight="semibold">
        {label}
      </Typography>
      <Input
        accessibilityLabel={label}
        className="min-h-12 rounded-2xl px-4 font-sans text-body"
        variant="primary"
        {...inputProps}
      />
      {hint ? (
        <View className="px-1">
          <Typography.Paragraph type="body-xs" className="text-text-secondary">
            {hint}
          </Typography.Paragraph>
        </View>
      ) : null}
    </TextField>
  );
}
