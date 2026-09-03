import type { MobileSearchCategory } from "@/lib/mobile-search";

export interface MobileSearchFilterButtonProps {
  category: MobileSearchCategory;
  onCategoryChange: (category: MobileSearchCategory) => void;
}
