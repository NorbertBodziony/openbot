import { Link as LinkIcon } from "lucide-react-native";
import { memo } from "react";
import { type ColorValue, View } from "react-native";

export const ChatLinkIcon = memo(function ChatLinkIcon({
  color,
  compact,
}: {
  color: ColorValue | undefined;
  compact: boolean;
}) {
  const size = compact ? 12 : 14;

  return (
    <View
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={{ width: size, height: size }}
    >
      <LinkIcon color={String(color)} size={size} strokeWidth={1.8} />
    </View>
  );
});
