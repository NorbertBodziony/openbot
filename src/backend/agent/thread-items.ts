import { type DynamicRecord, isString } from "@openbot/contracts/runtime-values";
import type { AgentProvider } from "../agent-client";
import { AppServerError } from "../app-server-client";
import { type DynamicToolCallParams, getString, isRecord, type ThreadItem } from "../protocol";

export function isNonActionableCodexWarning(message: string): boolean {
  return message.startsWith("Skill descriptions were shortened to fit");
}

export function isArchivedThreadError(error: unknown): boolean {
  return error instanceof AppServerError && /\bis archived\b/i.test(error.message);
}

export function isMissingProviderSessionError(error: unknown, provider: AgentProvider): boolean {
  if (provider !== "grok" || !(error instanceof Error)) return false;
  return (
    /\bunknown grok session\b/i.test(error.message) ||
    /\bsession\b.*\b(?:not found|does not exist|unknown)\b/i.test(error.message) ||
    /\b(?:not found|unknown)\b.*\bsession\b/i.test(error.message)
  );
}

export function isRequestTimeout(error: unknown, method: string): boolean {
  return error instanceof Error && error.message === `Codex request timed out: ${method}`;
}

export function isDynamicToolCall(value: unknown): value is DynamicToolCallParams {
  return (
    isRecord(value) &&
    isString(value.threadId) &&
    isString(value.turnId) &&
    isString(value.callId) &&
    (isString(value.namespace) || value.namespace === null) &&
    isString(value.tool) &&
    "arguments" in value
  );
}

export function toThreadItem(value: DynamicRecord): ThreadItem | null {
  const type = getString(value, "type");
  return type ? { ...value, type } : null;
}

export function toolProgressText(item: ThreadItem, completed: boolean): string | null {
  const type = item.type.toLowerCase();
  if (!/(tool.*call|commandexecution|filechange|websearch|computeraction)/u.test(type)) return null;
  if (completed && getString(item, "status") === "failed") {
    return "A tool step failed; reviewing the result and deciding what to try next…";
  }

  const descriptor = [item.type, getString(item, "name"), getString(item, "title"), getString(item, "tool")]
    .filter(isString)
    .join(" ")
    .toLowerCase();
  if (/(search|browser|fetch|navigate|open_url|web)/u.test(descriptor)) {
    return completed ? "Reviewing the sources and information I found…" : "Searching for current information…";
  }
  if (/(read|find|list|get|inspect|snapshot)/u.test(descriptor)) {
    return completed ? "Reviewing the information I gathered…" : "Gathering the relevant information…";
  }
  if (/(test|check|lint|build|verify)/u.test(descriptor)) {
    return completed ? "Reviewing the verification results…" : "Checking the work…";
  }
  if (/(write|edit|patch|create|update|delete|move|filechange)/u.test(descriptor)) {
    return completed ? "Reviewing the changes I made…" : "Making the requested changes…";
  }
  if (/(agent|delegate|message|send)/u.test(descriptor)) {
    return completed ? "Reviewing the other agent’s response…" : "Coordinating with another agent…";
  }
  return completed ? "Reviewing the latest tool result…" : "Working through the next tool-assisted step…";
}

export function cleanModelName(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  return value.replace(/^GPT-5\.6[\s:–—-]*/i, "").trim() || fallback;
}

export function providerForBot(bot: { provider: AgentProvider }): AgentProvider {
  return bot.provider;
}

export function providerLabel(provider: AgentProvider): "Claude" | "Codex" | "Grok" {
  if (provider === "claude") return "Claude";
  if (provider === "grok") return "Grok";
  return "Codex";
}
