import { Typography } from "heroui-native";
import { useThemeColor } from "heroui-native/hooks";
import { FileText, type LucideIcon, MessageCircle, Repeat2 } from "lucide-react-native";
import { View } from "react-native";

import { BotListRow } from "@/features/agents/components/agent-list-row";
import type { MobileSearchResult } from "@/features/search/model/mobile-search";

const RESULT_ICONS: Record<Exclude<MobileSearchResult["category"], "bots">, LucideIcon> = {
  messages: MessageCircle,
  files: FileText,
  routines: Repeat2,
};

export function MobileSearchResultRow({ result }: { result: MobileSearchResult }) {
  const [muted, controlBackground] = useThemeColor(["muted", "default"]);

  if (result.category === "bots") {
    return (
      <BotListRow
        avatarLocation="search"
        bot={result.bot}
        dismissToChat
        enableActions={false}
        enableZoomTransition={false}
      />
    );
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
          <Typography.Paragraph className="min-w-0 flex-1" weight="semibold" numberOfLines={1}>
            {result.title}
          </Typography.Paragraph>
          <Typography.Paragraph type="body-xs" className="text-text-dim">
            {result.updatedLabel}
          </Typography.Paragraph>
        </View>
        <Typography.Paragraph type="body-xs" className="text-text-secondary" numberOfLines={1}>
          {result.subtitle}
        </Typography.Paragraph>
      </View>
    </View>
  );
}
