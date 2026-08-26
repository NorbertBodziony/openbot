import type { BotAvatarHue, BotSummary, RoutineSchedule } from "./ipc-conversation";

export type AgentReviewStatus = "pending" | "approved" | "rejected";

export interface MarketplaceAgentSkill {
  skillId: string;
  versionId: string;
  slug: string;
  name: string;
  version: number;
}

export interface MarketplaceAgentRoutine {
  name: string;
  instruction: string;
  active: boolean;
  schedule: RoutineSchedule;
}

export interface MarketplaceAgentSummary {
  id: string;
  name: string;
  title: string;
  description: string;
  creatorName: string;
  version: number;
  installs: number;
  featured: boolean;
  avatarSeed: string;
  avatarHue: BotAvatarHue | null;
  avatarUrl: string | null;
  skillCount: number;
  routineCount: number;
  activeRoutineCount: number;
  updatedAt: string;
}

export interface MarketplaceAgentDetail extends MarketplaceAgentSummary {
  versionId: string;
  skills: MarketplaceAgentSkill[];
  routines: MarketplaceAgentRoutine[];
}

export interface MarketplaceAgentPage {
  agents: MarketplaceAgentSummary[];
  nextCursor: string | null;
}

export interface MarketplaceAgentQuery {
  query?: string;
  featured?: boolean;
  sort?: "installs";
  cursor?: string;
  limit?: number;
}

export interface AgentSubmission {
  id: string;
  agentId: string;
  name: string;
  title: string;
  description: string;
  version: number;
  status: AgentReviewStatus;
  rejectionNote: string | null;
  avatarSeed: string;
  avatarHue: BotAvatarHue | null;
  avatarUrl: string | null;
  skillCount: number;
  routineCount: number;
  activeRoutineCount: number;
  createdAt: string;
}

export interface AgentPublicationPreview {
  botId: string;
  name: string;
  title: string;
  description: string;
  avatarSeed: string;
  avatarHue: BotAvatarHue | null;
  avatarUrl: string | null;
  skills: MarketplaceAgentSkill[];
  routines: MarketplaceAgentRoutine[];
}

export interface SubmitMarketplaceAgentInput {
  botId: string;
  agentId?: string;
}

export interface InstallMarketplaceAgentInput {
  agentId: string;
  timezone: string;
  receiptId: string;
}

export interface InstallMarketplaceAgentResult {
  bot: BotSummary;
}
