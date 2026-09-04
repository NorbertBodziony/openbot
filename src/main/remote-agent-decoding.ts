// Agent-shaped wire payloads: summaries, status, models, skills, memories, routines, queue.
// See `remote-host-decoding.ts` for why the `FromHost` suffix exists and must not be merged away.

import type {
  AccountUsage,
  AgentModelOption,
  AgentStatus,
  BotMemory,
  BotSummary,
  DraftAttachment,
  DuplicateBotResult,
  InstalledSkill,
  QueuedMessageReceipt,
  QueueSnapshot,
  SidebarLayoutSnapshot,
} from "@openbot/contracts/ipc";
import {
  isAccountUsage,
  isAgentModelOption,
  isAgentStatus,
  isAttachmentSummary,
  isBotMemory,
  isBotSummary,
  isQueuedMessageReceipt,
  isQueueSnapshot,
  isRoutine,
  isRoutineRun,
  isSidebarLayoutSnapshot,
} from "@openbot/contracts/ipc";
import {
  decodeRecord,
  guardedDecoder,
  guardedListDecoder,
  requiredNumber,
  requiredString,
} from "@openbot/contracts/ipc-decoding";
import { isNumber, isOneOf, isString } from "@openbot/contracts/runtime-values";

export function decodeDraftAttachment(value: unknown): DraftAttachment {
  if (!isAttachmentSummary(value)) throw new Error("Invalid attachment.");
  return {
    id: value.id,
    name: value.name,
    size: value.size,
    kind: value.kind,
    mimeType: value.mimeType,
    previewKind: value.previewKind,
    previewUrl: value.previewUrl,
  };
}

export function decodeBotSummary(value: unknown): BotSummary {
  const record = decodeRecord(value, "agent");
  // Servers older than 63b55606 omit `avatarUrl` entirely. The shared guard requires the field, so
  // normalize the absent case to null before validating rather than loosening the guard for everyone.
  const candidate = record.avatarUrl === undefined ? { ...record, avatarUrl: null } : record;
  if (!isBotSummary(candidate)) throw new Error("Invalid agent.");
  const marketplaceSource = decodeMarketplaceSource(candidate.marketplaceSource);
  return {
    id: candidate.id,
    provider: candidate.provider,
    name: candidate.name,
    title: candidate.title,
    description: candidate.description,
    notifications: candidate.notifications,
    model: candidate.model,
    reasoningEffort: candidate.reasoningEffort,
    threadId: candidate.threadId,
    workspacePath: candidate.workspacePath,
    preview: candidate.preview,
    updatedAt: candidate.updatedAt,
    avatarSeed: candidate.avatarSeed,
    avatarHue: candidate.avatarHue,
    avatarUrl: candidate.avatarUrl,
    ...(marketplaceSource === undefined ? {} : { marketplaceSource }),
  };
}

function decodeMarketplaceSource(value: unknown): BotSummary["marketplaceSource"] {
  if (value === undefined) return undefined;
  const record = decodeRecord(value, "agent marketplace source");
  const skillIds = record.skillIds;
  const routineIds = record.routineIds;
  if (
    !isString(record.agentId) ||
    !isString(record.versionId) ||
    !isNumber(record.version) ||
    !Number.isInteger(record.version) ||
    !Array.isArray(skillIds) ||
    !skillIds.every(isString) ||
    !Array.isArray(routineIds) ||
    !routineIds.every(isString)
  ) {
    throw new Error("Invalid agent marketplace source.");
  }
  return {
    agentId: record.agentId,
    versionId: record.versionId,
    version: record.version,
    skillIds: [...skillIds],
    routineIds: [...routineIds],
  };
}

export function decodeAgentStatusFromHost(value: unknown): AgentStatus {
  if (!isAgentStatus(value)) {
    throw new Error("Invalid remote agent status.");
  }
  return value;
}

export function decodeAccountUsageFromHost(value: unknown): AccountUsage {
  if (!isAccountUsage(value)) {
    throw new Error("Invalid remote account usage.");
  }
  return value;
}

export function decodeAgentModelOptions(value: unknown): AgentModelOption[] {
  if (!Array.isArray(value) || !value.every(isAgentModelOption)) {
    throw new Error("Invalid remote agent models.");
  }
  return value;
}

export function decodeBotSummaries(value: unknown): BotSummary[] {
  if (!Array.isArray(value)) throw new Error("Invalid remote agent list.");
  return value.map(decodeBotSummary);
}

export function decodeInstalledSkillsFromHost(value: unknown): InstalledSkill[] {
  if (!Array.isArray(value)) throw new Error("Invalid installed skill list.");
  return value.map((item) => {
    const skill = decodeRecord(item, "installed skill");
    const state = requiredString(skill, "state");
    if (!isOneOf(["installed", "update-available", "modified", "needs-repair"] as const, state)) {
      throw new Error("Invalid installed skill state.");
    }
    return {
      skillId: requiredString(skill, "skillId"),
      slug: requiredString(skill, "slug"),
      name: requiredString(skill, "name"),
      installedVersion: requiredNumber(skill, "installedVersion"),
      availableVersion: requiredNumber(skill, "availableVersion"),
      state,
    };
  });
}

export function decodeBotMemory(value: unknown): BotMemory {
  if (!isBotMemory(value)) throw new Error("Invalid remote agent memory.");
  return value;
}

export function decodeBotMemories(value: unknown): BotMemory[] {
  if (!Array.isArray(value) || !value.every(isBotMemory)) {
    throw new Error("Invalid remote agent memories.");
  }
  return value;
}

export const decodeRoutine = guardedDecoder(isRoutine, "remote routine");
export const decodeRoutines = guardedListDecoder(isRoutine, "remote routine list");
export const decodeRoutineRun = guardedDecoder(isRoutineRun, "remote routine run");
export const decodeRoutineRuns = guardedListDecoder(isRoutineRun, "remote routine history");

export function decodeSidebarLayoutSnapshot(value: unknown): SidebarLayoutSnapshot {
  if (!isSidebarLayoutSnapshot(value)) throw new Error("Invalid sidebar layout response.");
  return value;
}

export function decodeDuplicateBotResultFromHost(value: unknown): DuplicateBotResult {
  const record = decodeRecord(value, "agent duplication");
  return {
    bot: decodeBotSummary(record.bot),
    layout: decodeSidebarLayoutSnapshot(record.layout),
  };
}

export function decodeQueueSnapshot(value: unknown): QueueSnapshot {
  if (!isQueueSnapshot(value)) {
    throw new Error("Invalid remote queue.");
  }
  return value;
}

export function decodeQueuedMessageReceipt(value: unknown): QueuedMessageReceipt {
  if (!isQueuedMessageReceipt(value)) {
    throw new Error("Invalid remote message receipt.");
  }
  return value;
}
