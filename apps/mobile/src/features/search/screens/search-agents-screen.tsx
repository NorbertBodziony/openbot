import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { Typography } from "heroui-native";
import { useThemeColor } from "heroui-native/hooks";
import { Search } from "lucide-react-native";
import { useMemo, useState } from "react";
import { View } from "react-native";

import { MobileSearchFilterButton } from "@/features/search/components/search-filter-button";
import { MobileSearchResultRow } from "@/features/search/components/search-result-row";
import { MobileSearchTextInput } from "@/features/search/components/search-text-input";
import {
  createMobileSearchResults,
  getMobileSearchResultText,
  type MobileSearchCategory,
} from "@/features/search/model/mobile-search";
import { useMobileWorkspace } from "@/features/workspace/context/mobile-workspace-context";
import { SheetScrollView } from "@/shared/components/sheet-scroll-view";

export function SearchAgentsScreen() {
  const { activeAgents } = useMobileWorkspace();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<MobileSearchCategory>("all");
  const [muted, fieldBackground] = useThemeColor(["muted", "default"]);
  const liquidGlassAvailable = isLiquidGlassAvailable();
  const filteredResults = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return createMobileSearchResults(activeAgents).filter((result) => {
      const matchesCategory = category === "all" || result.category === category;
      const matchesQuery =
        !normalizedQuery ||
        getMobileSearchResultText(result).some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
      return matchesCategory && matchesQuery;
    });
  }, [activeAgents, category, query]);

  return (
    <SheetScrollView
      className="flex-1 bg-background"
      contentContainerClassName="pb-safe-offset-5"
      contentInsetAdjustmentBehavior="automatic"
      header={
        <View className="flex-row items-center gap-2 px-5 pb-3 pt-7">
          <GlassView
            glassEffectStyle={liquidGlassAvailable ? "regular" : "none"}
            isInteractive={liquidGlassAvailable}
            style={{
              backgroundColor: liquidGlassAvailable ? "transparent" : fieldBackground,
              borderCurve: "continuous",
              borderRadius: 18,
              flex: 1,
              height: 48,
              overflow: "hidden",
            }}
          >
            <View className="h-12 flex-row items-center gap-2 px-3">
              <Search color={String(muted)} size={19} strokeWidth={2} />
              <MobileSearchTextInput value={query} onChangeText={setQuery} />
            </View>
          </GlassView>

          <MobileSearchFilterButton category={category} onCategoryChange={setCategory} />
        </View>
      }
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      {filteredResults.length > 0 ? (
        filteredResults.map((result) => <MobileSearchResultRow key={result.id} result={result} />)
      ) : (
        <View className="items-center px-8 py-12">
          <Typography.Paragraph align="center" weight="semibold">
            No matching results
          </Typography.Paragraph>
          <Typography.Paragraph type="body-xs" align="center" className="mt-1 text-text-secondary">
            Try a different search or choose another filter.
          </Typography.Paragraph>
        </View>
      )}
    </SheetScrollView>
  );
}
