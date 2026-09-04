import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  AgentProviderId,
  DynamicIslandAction,
  DynamicIslandPreference,
  DynamicIslandPresentation,
  ExternalDestination,
  InstallMarketplaceAgentInput,
  InstallSkillInput,
  MacPermissionId,
  MarketplaceAgentQuery,
  MarketplaceSkillQuery,
  PublishHostedSiteInput,
  ReplaceHostedSiteInput,
  SetAnalyticsPreferenceInput,
  SubmitMarketplaceAgentInput,
  SubmitSkillInput,
  UninstallSkillInput,
  UpdatePreference,
} from "@openbot/contracts/ipc";
import {
  isDynamicIslandAction,
  isDynamicIslandInteractive,
  isDynamicIslandPreference,
  isDynamicIslandPresentation,
  isSkillCategory,
} from "@openbot/contracts/ipc";
import { type DynamicRecord, isBoolean, isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import { validateProfileName } from "@openbot/contracts/validation";
import { parseAvatarImage } from "./avatar-inputs";
import { isObject, optionalBoolean, requireString } from "./validation";

export function parseProvider(input: unknown): AgentProviderId {
  if (!isDynamicRecord(input)) throw new Error("Setup input is required.");
  const provider = input.preferredProvider;
  if (provider !== "codex" && provider !== "claude" && provider !== "grok") throw new Error("Unknown provider.");
  return provider;
}

export function parseProviderId(input: unknown): AgentProviderId {
  if (input !== "codex" && input !== "claude" && input !== "grok") throw new Error("Unknown provider.");
  return input;
}

export function parseAnalyticsPreference(input: unknown): SetAnalyticsPreferenceInput {
  if (!isDynamicRecord(input) || !isBoolean(input.enabled)) throw new Error("Analytics preference is required.");
  return { enabled: input.enabled };
}

export function parseUpdatePreference(input: unknown): UpdatePreference {
  if (!isDynamicRecord(input) || !isBoolean(input.autoDownload)) throw new Error("Update preference is required.");
  return { autoDownload: input.autoDownload };
}

export function parseDynamicIslandPreference(input: unknown): DynamicIslandPreference {
  if (!isDynamicIslandPreference(input)) {
    throw new Error("Dynamic Island preference is required.");
  }
  return input;
}

export function parseDynamicIslandInteractive(input: unknown): { interactive: boolean } {
  if (!isDynamicIslandInteractive(input)) {
    throw new Error("Dynamic Island interaction state is required.");
  }
  return input;
}

export function parseDynamicIslandPresentation(input: unknown): DynamicIslandPresentation {
  if (!isDynamicIslandPresentation(input)) throw new Error("Dynamic Island presentation is invalid.");
  return input;
}

export function parseDynamicIslandAction(input: unknown): DynamicIslandAction {
  if (isDynamicIslandAction(input)) return input;
  throw new Error("Dynamic Island action is invalid.");
}

export function parseMacPermission(input: unknown): MacPermissionId {
  if (input !== "screen-recording" && input !== "accessibility") {
    throw new Error("Unknown macOS permission.");
  }
  return input;
}

export function parseExternalDestination(input: unknown): ExternalDestination {
  if (
    input !== "agent-setup" &&
    input !== "claude-install" &&
    input !== "claude-sign-in" &&
    input !== "feedback" &&
    input !== "message"
  ) {
    throw new Error("Unknown external destination.");
  }
  return input;
}

export function parseEmailCodeVerification(input: unknown): { challengeId: string; code: string } {
  if (!isObject(input)) throw new Error("Sign-in code details are required.");
  return {
    challengeId: requireString(input.challengeId, "challengeId", INPUT_LIMITS.identifier),
    code: requireString(input.code, "code", 32),
  };
}

export function parseProfileName(input: unknown): string {
  const validation = validateProfileName(requireString(input, "name", INPUT_LIMITS.accountName));
  if (validation.error) {
    throw new Error(`name must contain ${INPUT_LIMITS.profileNameMin} to ${INPUT_LIMITS.profileName} safe characters.`);
  }
  return validation.name;
}

// The two marketplaces share a query shape; only the category filter and the error wording differ.
// `query` is truncated rather than rejected, which is the behaviour these channels have always had.
function parseMarketplaceQueryFields(input: DynamicRecord, sortError: string): MarketplaceAgentQuery {
  if (input.sort !== undefined && input.sort !== "installs") throw new Error(sortError);
  return {
    ...(isString(input.query) ? { query: input.query.slice(0, 100) } : {}),
    ...(input.featured === true ? { featured: true } : {}),
    ...(input.sort === "installs" ? { sort: "installs" as const } : {}),
    ...(isString(input.cursor) ? { cursor: input.cursor } : {}),
    ...(isNumber(input.limit) ? { limit: input.limit } : {}),
  };
}

export function parseMarketplaceSkillQuery(input: unknown): MarketplaceSkillQuery {
  if (!isObject(input)) throw new Error("Invalid marketplace query.");
  const category = input.category;
  if (category !== undefined && !isSkillCategory(category)) throw new Error("Unknown skill category.");
  return {
    ...parseMarketplaceQueryFields(input, "Unknown skill sort order."),
    ...(category ? { category } : {}),
  };
}

export function parseMarketplaceAgentQuery(input: unknown): MarketplaceAgentQuery {
  if (!isObject(input)) throw new Error("Invalid agent marketplace query.");
  return parseMarketplaceQueryFields(input, "Unknown agent sort order.");
}

export function parseSubmitSkill(input: unknown): SubmitSkillInput {
  if (!isObject(input) || !isSkillCategory(input.category)) throw new Error("Invalid skill submission.");
  return {
    draftId: requireString(input.draftId, "draftId"),
    category: input.category,
    icon: parseAvatarImage(input.icon),
    ...(input.skillId === undefined ? {} : { skillId: requireString(input.skillId, "skillId") }),
  };
}

export function parseInstallSkill(input: unknown): InstallSkillInput {
  if (!isObject(input)) throw new Error("Invalid skill installation.");
  return {
    agentId: requireString(input.agentId, "agentId"),
    skillId: requireString(input.skillId, "skillId"),
    ...(input.replaceModified === true ? { replaceModified: true } : {}),
  };
}

export function parseUninstallSkill(input: unknown): UninstallSkillInput {
  if (!isObject(input)) throw new Error("Invalid skill removal.");
  return {
    agentId: requireString(input.agentId, "agentId"),
    skillId: requireString(input.skillId, "skillId"),
    ...(input.removeModified === true ? { removeModified: true } : {}),
  };
}

export function parsePublishHostedSite(input: unknown): PublishHostedSiteInput {
  if (!isObject(input)) throw new Error("Invalid site publication.");
  const spaFallback = optionalBoolean(input.spaFallback, "spaFallback");
  return {
    sourcePath: requireString(input.sourcePath, "sourcePath", INPUT_LIMITS.path),
    title: requireString(input.title, "title", 120),
    description: requireString(input.description, "description", 500),
    ...(spaFallback !== undefined ? { spaFallback } : {}),
  };
}

export function parseReplaceHostedSite(input: unknown): ReplaceHostedSiteInput {
  if (!isObject(input)) throw new Error("Invalid site replacement.");
  const spaFallback = optionalBoolean(input.spaFallback, "spaFallback");
  return {
    siteId: requireString(input.siteId, "siteId", INPUT_LIMITS.identifier),
    sourcePath: requireString(input.sourcePath, "sourcePath", INPUT_LIMITS.path),
    title: requireString(input.title, "title", 120),
    description: requireString(input.description, "description", 500),
    ...(spaFallback !== undefined ? { spaFallback } : {}),
  };
}

export function parseDeleteHostedSite(input: unknown): string {
  if (!isObject(input)) throw new Error("Invalid site deletion.");
  return requireString(input.siteId, "siteId", INPUT_LIMITS.identifier);
}

export function parseSubmitMarketplaceAgent(input: unknown): SubmitMarketplaceAgentInput {
  if (!isObject(input)) throw new Error("Invalid agent submission.");
  return {
    agentId: requireString(input.agentId, "agentId"),
    ...(input.listingId === undefined ? {} : { listingId: requireString(input.listingId, "listingId") }),
  };
}

export function parseInstallMarketplaceAgent(input: unknown): InstallMarketplaceAgentInput {
  if (!isObject(input)) throw new Error("Invalid agent installation.");
  return {
    listingId: requireString(input.listingId, "listingId"),
    ...(input.agentId === undefined
      ? {}
      : { agentId: requireString(input.agentId, "agentId", INPUT_LIMITS.identifier) }),
    timezone: requireString(input.timezone, "timezone", 255),
    receiptId: requireString(input.receiptId, "receiptId", INPUT_LIMITS.identifier),
  };
}
