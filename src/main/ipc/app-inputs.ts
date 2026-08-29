import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  AgentProviderId,
  DynamicIslandAction,
  DynamicIslandAttentionItem,
  DynamicIslandBotIdentity,
  DynamicIslandMessageItem,
  DynamicIslandPresentation,
  DynamicIslandQuestionItem,
  DynamicIslandWorkingItem,
  ExternalDestination,
  MacPermissionId,
  SetAnalyticsPreferenceInput,
} from "@openbot/contracts/ipc";
import { isAvatarHue } from "@openbot/contracts/ipc";
import { isBoolean, isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";

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

export function parseDynamicIslandPreference(input: unknown): { enabled: boolean } {
  if (!isDynamicRecord(input) || !isBoolean(input.enabled)) {
    throw new Error("Dynamic Island preference is required.");
  }
  return { enabled: input.enabled };
}

export function parseDynamicIslandInteractive(input: unknown): { interactive: boolean } {
  if (!isDynamicRecord(input) || !isBoolean(input.interactive)) {
    throw new Error("Dynamic Island interaction state is required.");
  }
  return { interactive: input.interactive };
}

export function parseDynamicIslandPresentation(input: unknown): DynamicIslandPresentation {
  if (!isDynamicRecord(input)) throw new Error("Dynamic Island presentation is required.");
  const mode = input.mode;
  if (
    mode !== "idle" &&
    mode !== "working" &&
    mode !== "message" &&
    mode !== "question" &&
    mode !== "approval" &&
    mode !== "takeover" &&
    mode !== "failed"
  ) {
    throw new Error("Dynamic Island mode is invalid.");
  }
  if (
    !isShortString(input.serverId, 160) ||
    !isSafeCount(input.activeCount) ||
    !isSafeCount(input.unreadCount) ||
    !isSafeCount(input.attentionCount) ||
    !Array.isArray(input.working) ||
    input.working.length > 3 ||
    !input.working.every(isWorkingItem) ||
    (input.message !== null && !isMessageItem(input.message)) ||
    !Array.isArray(input.attention) ||
    input.attention.length > 3 ||
    !input.attention.every(isAttentionItem)
  ) {
    throw new Error("Dynamic Island presentation is invalid.");
  }
  return {
    serverId: input.serverId,
    mode,
    activeCount: input.activeCount,
    unreadCount: input.unreadCount,
    attentionCount: input.attentionCount,
    working: input.working,
    message: input.message,
    attention: input.attention,
  };
}

export function parseDynamicIslandAction(input: unknown): DynamicIslandAction {
  if (!isDynamicRecord(input) || !isString(input.type)) {
    throw new Error("Dynamic Island action is required.");
  }
  if (input.type === "open-app") return { type: "open-app" };
  if (!isShortString(input.serverId, 160) || !isShortString(input.botId, 160)) {
    throw new Error("Dynamic Island action target is invalid.");
  }
  if (input.type === "open-bot") {
    return { type: input.type, serverId: input.serverId, botId: input.botId };
  }
  if (input.type === "open-message" && isShortString(input.messageId, 160)) {
    return { type: input.type, serverId: input.serverId, botId: input.botId, messageId: input.messageId };
  }
  if (input.type === "open-failure" && isShortString(input.turnId, 160)) {
    return { type: input.type, serverId: input.serverId, botId: input.botId, turnId: input.turnId };
  }
  if (
    (input.type === "review-attention" || input.type === "approve-attention") &&
    isDynamicIslandRequestId(input.requestId)
  ) {
    return { type: input.type, serverId: input.serverId, botId: input.botId, requestId: input.requestId };
  }
  if (
    input.type === "answer-prompt" &&
    isDynamicIslandRequestId(input.requestId) &&
    isDynamicIslandAnswers(input.answers)
  ) {
    return {
      type: input.type,
      serverId: input.serverId,
      botId: input.botId,
      requestId: input.requestId,
      answers: input.answers,
    };
  }
  throw new Error("Dynamic Island action is invalid.");
}

function isSafeCount(value: unknown): value is number {
  return isNumber(value) && Number.isInteger(value) && value >= 0 && value <= 10_000;
}

function isShortString(value: unknown, length: number): value is string {
  return isString(value) && value.length > 0 && value.length <= length;
}

function isBotIdentity(value: unknown): value is DynamicIslandBotIdentity {
  if (!isDynamicRecord(value)) return false;
  return (
    isShortString(value.id, 160) &&
    isShortString(value.name, 120) &&
    isShortString(value.avatarSeed, 160) &&
    (value.avatarHue === null || isAvatarHue(value.avatarHue)) &&
    (value.avatarUrl === null || isShortString(value.avatarUrl, 2_048))
  );
}

function isWorkingItem(value: unknown): value is DynamicIslandWorkingItem {
  return isDynamicRecord(value) && isBotIdentity(value.bot) && isShortString(value.task, 240);
}

function isMessageItem(value: unknown): value is DynamicIslandMessageItem {
  return (
    isDynamicRecord(value) &&
    isBotIdentity(value.bot) &&
    isShortString(value.messageId, 160) &&
    isShortString(value.text, 600) &&
    isShortString(value.createdAt, 80)
  );
}

function isAttentionItem(value: unknown): value is DynamicIslandAttentionItem {
  if (
    !isDynamicRecord(value) ||
    !isShortString(value.id, 160) ||
    !isDynamicIslandRequestId(value.requestId) ||
    !isBotIdentity(value.bot) ||
    (value.kind !== "prompt" && value.kind !== "approval" && value.kind !== "takeover" && value.kind !== "failure") ||
    !isShortString(value.title, 180) ||
    (value.detail !== null && !isShortString(value.detail, 600)) ||
    !isDynamicIslandOptions(value.options) ||
    !isDynamicIslandQuestions(value.questions)
  ) {
    return false;
  }
  if (value.kind === "prompt") return value.approval === null;
  if (value.kind === "takeover" || value.kind === "failure") {
    return value.options === null && value.questions === null && value.approval === null;
  }
  return value.options === null && value.questions === null && isDynamicIslandApproval(value.approval);
}

function isDynamicIslandRequestId(value: unknown): value is string | number {
  return isShortString(value, 160) || (isNumber(value) && Number.isSafeInteger(value));
}

function isDynamicIslandOptions(value: unknown): value is DynamicIslandAttentionItem["options"] {
  return (
    value === null ||
    (Array.isArray(value) &&
      value.length <= 4 &&
      value.every(
        (option) =>
          isDynamicRecord(option) && isShortString(option.label, 120) && isShortString(option.description, 240),
      ))
  );
}

function isDynamicIslandQuestions(value: unknown): value is DynamicIslandQuestionItem[] | null {
  return (
    value === null ||
    (Array.isArray(value) && value.length <= INPUT_LIMITS.promptQuestions && value.every(isDynamicIslandQuestion))
  );
}

function isDynamicIslandQuestion(value: unknown): value is DynamicIslandQuestionItem {
  return (
    isDynamicRecord(value) &&
    isShortString(value.id, INPUT_LIMITS.identifier) &&
    isShortString(value.header, INPUT_LIMITS.promptHeader) &&
    isShortString(value.question, INPUT_LIMITS.promptQuestion) &&
    isBoolean(value.isSecret) &&
    (value.options === null ||
      (Array.isArray(value.options) &&
        value.options.length <= INPUT_LIMITS.promptOptions &&
        value.options.every(
          (option) =>
            isDynamicRecord(option) &&
            isShortString(option.label, INPUT_LIMITS.promptOptionLabel) &&
            isShortString(option.description, INPUT_LIMITS.promptOptionDescription),
        )))
  );
}

function isDynamicIslandAnswers(value: unknown): value is Record<string, string[]> {
  if (!isDynamicRecord(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length > 0 &&
    entries.length <= INPUT_LIMITS.promptQuestions &&
    entries.every(
      ([questionId, answers]) =>
        isShortString(questionId, INPUT_LIMITS.identifier) &&
        Array.isArray(answers) &&
        answers.length === 1 &&
        answers.every((answer) => isShortString(answer, INPUT_LIMITS.promptOptionLabel)),
    )
  );
}

function isDynamicIslandApproval(value: unknown): boolean {
  if (!isDynamicRecord(value)) return false;
  if (value.kind !== "command" && value.kind !== "file-change" && value.kind !== "permissions") return false;
  if (
    !isNullableShortString(value.command, 600) ||
    !isNullableShortString(value.cwd, 600) ||
    !isNullableShortString(value.reason, 600) ||
    !isNullableShortString(value.grantRoot, 600)
  ) {
    return false;
  }
  if (value.permissions === null) return true;
  if (!isDynamicRecord(value.permissions) || !isDynamicRecord(value.permissions.fileSystem)) return false;
  const fileSystem = value.permissions.fileSystem;
  return (
    isBoolean(value.permissions.network) && isShortStringList(fileSystem.read) && isShortStringList(fileSystem.write)
  );
}

function isNullableShortString(value: unknown, length: number): boolean {
  return value === null || isShortString(value, length);
}

function isShortStringList(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 3 && value.every((item) => isShortString(item, 600));
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
