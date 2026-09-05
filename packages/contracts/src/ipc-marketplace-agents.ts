import type { AvatarHue } from "./ipc-agent-identity";
import type { AgentSummary } from "./ipc-agents";
import type { RoutineSchedule } from "./ipc-routines";

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
  avatarHue: AvatarHue | null;
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
  listingId: string;
  name: string;
  title: string;
  description: string;
  version: number;
  status: AgentReviewStatus;
  rejectionNote: string | null;
  avatarSeed: string;
  avatarHue: AvatarHue | null;
  avatarUrl: string | null;
  skillCount: number;
  routineCount: number;
  activeRoutineCount: number;
  createdAt: string;
}

export interface AgentPublicationPreview {
  agentId: string;
  name: string;
  title: string;
  description: string;
  avatarSeed: string;
  avatarHue: AvatarHue | null;
  avatarUrl: string | null;
  skills: MarketplaceAgentSkill[];
  routines: MarketplaceAgentRoutine[];
}

export interface SubmitMarketplaceAgentInput {
  agentId: string;
  listingId?: string;
}

export interface InstallMarketplaceAgentInput {
  listingId: string;
  agentId?: string;
  timezone: string;
  receiptId: string;
}

export interface InstallMarketplaceAgentResult {
  agent: AgentSummary;
}
