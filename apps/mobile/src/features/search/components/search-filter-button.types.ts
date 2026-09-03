import type { MobileSearchCategory } from "@/features/search/model/mobile-search";

export interface MobileSearchFilterButtonProps {
  category: MobileSearchCategory;
  onCategoryChange: (category: MobileSearchCategory) => void;
}
