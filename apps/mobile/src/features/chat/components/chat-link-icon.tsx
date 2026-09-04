import { Image } from "expo-image";
import { Link as LinkIcon } from "lucide-react-native";
import { memo, useMemo, useState } from "react";
import { type ColorValue, View } from "react-native";

export const ChatLinkIcon = memo(function ChatLinkIcon({
  url,
  color,
  compact,
}: {
  url: string;
  color: ColorValue | undefined;
  compact: boolean;
}) {
  const source = useMemo(() => {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    // Request only the site's icon, never the message link's path, query, or credentials.
    return { uri: `${parsed.origin}/favicon.ico` };
  }, [url]);
  const [failedUri, setFailedUri] = useState<string | null>(null);
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
      {source && source.uri !== failedUri ? (
        <Image
          source={source}
          accessible={false}
          cachePolicy="memory-disk"
          contentFit="contain"
          recyclingKey={source.uri}
          style={{ position: "absolute", width: size, height: size, borderRadius: 3 }}
          onError={() => setFailedUri(source.uri)}
        />
      ) : null}
    </View>
  );
});
