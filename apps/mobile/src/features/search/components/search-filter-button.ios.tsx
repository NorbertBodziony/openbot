import { Host } from "@expo/ui";
import { Image, Menu, Toggle } from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  buttonBorderShape,
  buttonStyle,
  frame,
  glassEffect,
  menuIndicator,
  menuStyle,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import { isLiquidGlassAvailable } from "expo-glass-effect";
import { useThemeColor } from "heroui-native/hooks";

import type { MobileSearchFilterButtonProps } from "@/features/search/components/search-filter-button.types";
import { MOBILE_SEARCH_FILTERS } from "@/features/search/model/mobile-search";

export function MobileSearchFilterButton({ category, onCategoryChange }: MobileSearchFilterButtonProps) {
  const [foreground, muted] = useThemeColor(["foreground", "muted"]);
  const activeFilterLabel = MOBILE_SEARCH_FILTERS.find((filter) => filter.id === category)?.label ?? "All";
  const liquidGlassAvailable = isLiquidGlassAvailable();

  return (
    <Host ignoreSafeArea="all" style={{ height: 48, width: 48 }}>
      <Menu
        label={
          <Image color={category === "all" ? muted : foreground} size={20} systemName="line.3.horizontal.decrease" />
        }
        modifiers={[
          menuStyle("button"),
          buttonStyle(liquidGlassAvailable ? "plain" : "bordered"),
          menuIndicator("hidden"),
          frame({ height: 48, width: 48 }),
          ...(liquidGlassAvailable
            ? [
                glassEffect({
                  cornerRadius: 18,
                  glass: { interactive: true, variant: "regular" },
                  shape: "roundedRectangle",
                }),
              ]
            : [buttonBorderShape("roundedRectangle", 18)]),
          tint(String(foreground)),
          accessibilityLabel(`Filter results, ${activeFilterLabel}`),
        ]}
        testID="search-filter-menu"
      >
        {MOBILE_SEARCH_FILTERS.map((filter) => (
          <Toggle
            isOn={filter.id === category}
            key={filter.id}
            label={filter.label}
            onIsOnChange={() => onCategoryChange(filter.id)}
          />
        ))}
      </Menu>
    </Host>
  );
}
