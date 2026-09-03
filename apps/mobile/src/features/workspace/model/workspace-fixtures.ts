import type { MobileBot, MobileServer } from "@/features/workspace/model/workspace-types";

//! MOCK DATA RENDERED HERE
export const MOCK_SERVERS: MobileServer[] = [
  {
    id: "local",
    name: "My MacBook Pro",
    kind: "local",
    state: "online",
    address: null,
    accent: "#cdadec",
  },
  {
    id: "openbot-team",
    name: "OpenBot team",
    kind: "remote",
    state: "online",
    address: "team.openbot.run",
    accent: "#6960f1",
  },
  {
    id: "studio",
    name: "Studio Mac",
    kind: "remote",
    state: "offline",
    address: "studio.example.com",
    accent: "#e3b866",
  },
];

export const MOCK_BOTS: MobileBot[] = [
  {
    id: "chief",
    serverId: "local",
    name: "Chief",
    title: "Chief of staff",
    preview: "I pulled together the latest project notes and next steps.",
    updatedLabel: "10:00",
    avatarSeed: "chief:quiet-lead",
  },
  {
    id: "research",
    serverId: "local",
    name: "Research",
    title: "Research partner",
    preview: "Three useful sources are ready for your review.",
    updatedLabel: "Yesterday",
    avatarSeed: "research:curious-reader",
  },
  {
    id: "builder",
    serverId: "local",
    name: "Builder",
    title: "Product engineer",
    preview: "The mobile navigation prototype is ready to test.",
    updatedLabel: "Mon",
    avatarSeed: "builder:bright-spark",
  },
  {
    id: "sales",
    serverId: "openbot-team",
    name: "Sales Outbound",
    title: "Outbound specialist",
    preview: "The follow-up draft is ready to send.",
    updatedLabel: "09:20",
    avatarSeed: "sales:outbound-energy",
  },
  {
    id: "ops",
    serverId: "openbot-team",
    name: "Operations",
    title: "Team coordinator",
    preview: "All systems are healthy. Two approvals need your attention.",
    updatedLabel: "Tue",
    avatarSeed: "operations:steady-hand",
  },
];
