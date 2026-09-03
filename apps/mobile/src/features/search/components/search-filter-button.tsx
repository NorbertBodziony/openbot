import { type MenuAction, MenuView } from "@expo/ui/community/menu";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { useThemeColor } from "heroui-native/hooks";
import { ListFilter } from "lucide-react-native";
import { useMemo } from "react";

import type { MobileSearchFilterButtonProps } from "@/features/search/components/search-filter-button.types";
import { MOBILE_SEARCH_FILTERS } from "@/features/search/model/mobile-search";

export function MobileSearchFilterButton({ category, onCategoryChange }: MobileSearchFilterButtonProps) {
  const [foreground, muted, fieldBackground] = useThemeColor(["foreground", "muted", "default"]);
  const liquidGlassAvailable = isLiquidGlassAvailable();
  const activeFilterLabel = MOBILE_SEARCH_FILTERS.find((filter) => filter.id === category)?.label ?? "All";
  const actions = useMemo<MenuAction[]>(
    () =>
      MOBILE_SEARCH_FILTERS.map((filter) => ({
        id: filter.id,
        state: filter.id === category ? "on" : "off",
        title: filter.label,
      })),
    [category],
  );

  return (
    <MenuView
      actions={actions}
      onPressAction={(event) => {
        const selectedFilter = MOBILE_SEARCH_FILTERS.find((filter) => filter.id === event.nativeEvent.event);
        if (selectedFilter) onCategoryChange(selectedFilter.id);
      }}
      style={{ height: 48, width: 48 }}
      testID="search-filter-menu"
    >
      <GlassView
        accessibilityLabel={`Filter results, ${activeFilterLabel}`}
        accessibilityRole="button"
        accessible
        glassEffectStyle={liquidGlassAvailable ? "regular" : "none"}
        isInteractive={liquidGlassAvailable}
        tintColor={liquidGlassAvailable ? String(fieldBackground) : undefined}
        style={{
          alignItems: "center",
          backgroundColor: liquidGlassAvailable ? "transparent" : fieldBackground,
          borderCurve: "continuous",
          borderRadius: 18,
          height: 48,
          justifyContent: "center",
          overflow: "hidden",
          width: 48,
        }}
      >
        <ListFilter color={String(category === "all" ? muted : foreground)} size={20} strokeWidth={2} />
      </GlassView>
    </MenuView>
  );
}
