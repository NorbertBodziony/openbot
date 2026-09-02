import { useThemeColor } from "heroui-native/hooks";
import { FileText, type LucideIcon, MessageCircle, Repeat2 } from "lucide-react-native";
import { Text, View } from "react-native";

import { BotListRow } from "@/components/bot-list-row";
import type { MobileSearchResult } from "@/lib/mobile-search";

const RESULT_ICONS: Record<Exclude<MobileSearchResult["category"], "bots">, LucideIcon> = {
  messages: MessageCircle,
  files: FileText,
  routines: Repeat2,
};

export function MobileSearchResultRow({ result }: { result: MobileSearchResult }) {
  const [muted, controlBackground] = useThemeColor(["muted", "default"]);

  if (result.category === "bots") {
    return <BotListRow bot={result.bot} enableZoomTransition={false} />;
  }

  const Icon = RESULT_ICONS[result.category];

  return (
    <View className="min-h-20 flex-row items-center gap-3 px-5 py-3">
      <View
        className="size-[54px] items-center justify-center rounded-[18px]"
        style={{ backgroundColor: controlBackground }}
      >
        <Icon color={String(muted)} size={24} strokeWidth={1.8} />
      </View>
      <View className="min-w-0 flex-1 gap-1">
        <View className="flex-row items-baseline gap-2">
          <Text className="min-w-0 flex-1 font-sans text-body font-semibold text-foreground" numberOfLines={1}>
            {result.title}
          </Text>
          <Text className="font-sans text-caption text-text-dim">{result.updatedLabel}</Text>
        </View>
        <Text className="font-sans text-caption leading-5 text-text-secondary" numberOfLines={1}>
          {result.subtitle}
        </Text>
      </View>
    </View>
  );
}
