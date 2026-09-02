import { Image } from "expo-image";
import { useState } from "react";
import { Text, View } from "react-native";

interface ProfileAvatarProps {
  name: string;
  imageUrl?: string | null;
  accent?: string;
  size?: number;
}

export function ProfileAvatar({ name, imageUrl, accent = "#cdadec", size = 48 }: ProfileAvatarProps) {
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);
  const imageFailed = imageUrl === failedImageUrl;

  const initials = name
    .trim()
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");

  return (
    <View
      className="items-center justify-center overflow-hidden"
      style={{
        backgroundColor: accent,
        borderCurve: "continuous",
        borderRadius: size * 0.32,
        height: size,
        width: size,
      }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Text
        className="font-sans font-semibold text-[#100d12]"
        style={{ fontSize: Math.max(12, size * 0.3), lineHeight: size * 0.4 }}
      >
        {initials || "O"}
      </Text>
      {imageUrl && !imageFailed ? (
        <Image
          source={{ uri: imageUrl }}
          contentFit="cover"
          style={{ height: size, position: "absolute", width: size }}
          onError={() => setFailedImageUrl(imageUrl)}
        />
      ) : null}
    </View>
  );
}
