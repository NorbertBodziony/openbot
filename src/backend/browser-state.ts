import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { isString } from "@openbot/contracts/runtime-values";
import { isRecord } from "./protocol";
import { isGeneratedAgentId } from "./workspace-paths";

export interface StoredBrowserTab {
  id: string;
  url: string;
  ownerThreadId: string | null;
  ownerAgentId: string | null;
}

const X_HOSTS = new Set(["x.com", "www.x.com"]);
export const X_LANDING_URL = "https://x.com/";

export function persistentBrowserUrl(value: string): string {
  const url = new URL(value);
  if (X_HOSTS.has(url.hostname) && url.pathname === "/i/jf/onboarding/web") {
    return X_LANDING_URL;
  }
  return url.toString();
}

export function isPersistableBrowserUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * A tab a released build wrote spells the owner key `ownerBotId`, and rejecting it would filter out every
 * tab open at the moment of the upgrade, so the user's browser would come back empty. The id value moves
 * with the key, because migration v13 has already renamed the agent the tab belongs to and an owner that
 * matches nothing orphans the tab just as quietly. Only an id the application minted is rewritten, which
 * is the test v13 applies; v13 additionally declines when the `agent-` spelling is already taken, and a
 * JSON file cannot see that, so in that one case the tab reopens unowned rather than owned by a stranger.
 */
export function storedBrowserTab(value: unknown): StoredBrowserTab | null {
  if (
    !isRecord(value) ||
    !isString(value.id) ||
    !value.id ||
    value.id.length > INPUT_LIMITS.identifier ||
    !isString(value.url) ||
    value.url.length > INPUT_LIMITS.browserUrl
  ) {
    return null;
  }
  const ownerThreadId = value.ownerThreadId;
  if (ownerThreadId !== null && (!isString(ownerThreadId) || ownerThreadId.length > INPUT_LIMITS.identifier)) {
    return null;
  }
  const storedOwner = value.ownerAgentId === undefined ? (value.ownerBotId ?? null) : value.ownerAgentId;
  const ownerAgentId =
    isString(storedOwner) && isGeneratedAgentId(storedOwner) && storedOwner.startsWith("bot-")
      ? `agent-${storedOwner.slice("bot-".length)}`
      : storedOwner;
  if (ownerAgentId !== null && (!isString(ownerAgentId) || ownerAgentId.length > INPUT_LIMITS.identifier)) {
    return null;
  }
  if (!isPersistableBrowserUrl(value.url)) return null;
  return { id: value.id, url: value.url, ownerThreadId, ownerAgentId };
}
