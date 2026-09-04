import { createSignal } from "solid-js";
import { formatTime } from "./app-message-projection";
import { agentConversationKey } from "./conversation-keys";
import type { AgentMessage } from "./data";
import { createSimpleContext } from "./simple-context";

/**
 * The inline error feed of an agent's message list.
 *
 * It sits above the per-server scope, and that placement is the whole point: an
 * error is reported by whichever command failed, and a command can outlive the
 * workspace it was issued from. A voice message whose transcription resolves
 * after the user has moved to another server still sends to the server it was
 * dictated on, so its rejection has to be waiting when they come back.
 *
 * Keys are `agentConversationKey(serverId, agentId)`, so entries for a server you
 * are not looking at are unreachable rather than merely unrendered - which is
 * why nothing prunes this on a switch, and why a shared owner is safe.
 */
const UiErrors = createSimpleContext({
  name: "UI errors",
  init: () => {
    const [uiErrors, setUiErrors] = createSignal<Record<string, AgentMessage[]>>({});

    function appendUiError(agentId: string, error: unknown, status: string, serverId: string): void {
      const body = error instanceof Error ? error.message : String(error);
      const errorKey = agentConversationKey(serverId, agentId);
      setUiErrors((current) => ({
        ...current,
        [errorKey]: [
          ...(current[errorKey] ?? []),
          {
            id: `ui-${Date.now()}-${Math.random()}`,
            author: "agent",
            body,
            time: formatTime(new Date().toISOString()),
            status,
          },
        ],
      }));
    }

    return { uiErrors, setUiErrors, appendUiError };
  },
});

export const UiErrorsProvider = UiErrors.provider;
export const useUiErrors = UiErrors.use;
