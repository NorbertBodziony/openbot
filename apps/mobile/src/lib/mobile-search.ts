import type { MobileBot } from "@/providers/mobile-workspace-provider";

export type MobileSearchCategory = "all" | "messages" | "bots" | "files" | "routines";
export type MobileSearchResultCategory = Exclude<MobileSearchCategory, "all">;

export interface MobileSearchFilterOption {
  id: MobileSearchCategory;
  label: string;
}

interface MobileSearchTextResult {
  id: string;
  category: Exclude<MobileSearchResultCategory, "bots">;
  title: string;
  subtitle: string;
  updatedLabel: string;
}

interface MobileSearchBotResult {
  id: string;
  category: "bots";
  bot: MobileBot;
}

export type MobileSearchResult = MobileSearchTextResult | MobileSearchBotResult;

export const MOBILE_SEARCH_FILTERS: MobileSearchFilterOption[] = [
  { id: "all", label: "All" },
  { id: "messages", label: "Messages" },
  { id: "bots", label: "Bots" },
  { id: "files", label: "Files" },
  { id: "routines", label: "Routines" },
];

//! MOCK DATA RENDERED HERE
const MOCK_SEARCH_RESULTS: MobileSearchTextResult[] = [
  {
    id: "message-project-notes",
    category: "messages",
    title: "Project notes and next steps",
    subtitle: "Chief · I pulled together the latest project notes and next steps.",
    updatedLabel: "10:00",
  },
  {
    id: "message-research-sources",
    category: "messages",
    title: "Three useful sources",
    subtitle: "Research · The sources are ready for your review.",
    updatedLabel: "Yesterday",
  },
  {
    id: "file-mobile-navigation",
    category: "files",
    title: "mobile-navigation.md",
    subtitle: "Builder · Markdown document",
    updatedLabel: "Mon",
  },
  {
    id: "file-research-brief",
    category: "files",
    title: "research-brief.pdf",
    subtitle: "Research · PDF document",
    updatedLabel: "Yesterday",
  },
  {
    id: "routine-daily-brief",
    category: "routines",
    title: "Daily project brief",
    subtitle: "Runs every weekday at 09:00",
    updatedLabel: "Daily",
  },
  {
    id: "routine-research-digest",
    category: "routines",
    title: "Weekly research digest",
    subtitle: "Runs every Monday at 08:30",
    updatedLabel: "Weekly",
  },
];

export function createMobileSearchResults(activeBots: MobileBot[]): MobileSearchResult[] {
  return [
    ...activeBots.map<MobileSearchBotResult>((bot) => ({
      id: `bot-${bot.id}`,
      category: "bots",
      bot,
    })),
    ...MOCK_SEARCH_RESULTS,
  ];
}

export function getMobileSearchResultText(result: MobileSearchResult): string[] {
  if (result.category === "bots") {
    return [result.bot.name, result.bot.title, result.bot.preview];
  }

  return [result.title, result.subtitle];
}
