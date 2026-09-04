import type { DynamicIslandAction } from "@openbot/contracts/ipc";
import { createEffect, onSettled } from "solid-js";
import { useAgents } from "./agents";
import { withoutAgent } from "./app-message-projection";
import { toast } from "./components/ui";
import { useConversation } from "./conversation";
import { promptRequestKey } from "./conversation-keys";
import { useDynamicIsland } from "./dynamic-island";
import { useNavigation } from "./navigation";
import { usePlatform } from "./platform";
import { useServerScope } from "./server-scope";
import { useServerSelection } from "./server-selection";
import { useServerSwitch } from "./server-switch";
import { useServers } from "./servers";
import { useTurns } from "./turns";

/**
 * The two directions the macOS Dynamic Island talks in, for the server the user
 * is actually looking at: the projection out to main, and the actions coming
 * back.
 *
 * `dynamic-island.tsx` sits above every per-server domain and cannot read them -
 * it holds the coordinator and the background-server events. This is its
 * counterpart at the bottom of the tree, where the nine signals the projection
 * needs are readable. Splitting them is what keeps the coordinator alive across a
 * server switch while the projection stays scoped to the active one.
 *
 * The projection is withheld until the scope reports `loaded()`. Without that, a
 * mount would publish the new server's id next to a half-filled workspace for
 * exactly as long as its loads take. The flag is a boolean rather than a server
 * id because the scope it belongs to *is* one server: it starts false on every
 * mount and cannot describe the wrong one.
 *
 * Actions arrive for *any* server, including one that is not active, which is why
 * `handleDynamicIslandAction` may switch before it can act - and why it then
 * republishes the action through `server-switch.tsx` instead of finishing it: the
 * switch disposes this bridge, so the scope that lands has to run the rest. The
 * two that never need a switch - answering a prompt and responding to an
 * approval - resolve against the coordinator directly and republish, so a reply
 * from the island is reflected before the renderer has caught up.
 */
export function DynamicIslandBridge() {
  const platform = usePlatform();
  const { activeServerId } = useServers();
  const { dynamicIslandCoordinator, publishDynamicIslandPresentation } = useDynamicIsland();
  const { selectServer } = useServerSelection();
  const { loaded } = useServerScope();
  const { pendingIslandAction, setPendingIslandAction } = useServerSwitch();
  const { agentList, appendUiError } = useAgents();
  const {
    activeTurns,
    queues,
    pendingPrompts,
    setPendingPrompts,
    setSubmittedPromptRequests,
    pendingApprovals,
    setPendingApprovals,
    failedTurns,
    setFailedTurns,
  } = useTurns();
  const { unreadReplies, conversationReads, liveMessages } = useConversation();
  const { selectAgent, openAgentMessage } = useNavigation();
  /** The handoff this bridge published, so it never consumes or clears its own. */
  let publishedAction: DynamicIslandAction | null = null;

  createEffect(
    () => {
      if (platform.landingPreview || !loaded()) return null;
      return {
        serverId: activeServerId(),
        agents: agentList(),
        activeTurns: activeTurns(),
        queues: queues(),
        unreadReplies: unreadReplies(),
        unreadMessageIds: Object.fromEntries(
          Object.entries(conversationReads()).map(([agentId, state]) => [agentId, state.firstUnreadMessageId]),
        ),
        liveMessages: liveMessages(),
        pendingPrompts: pendingPrompts(),
        pendingApprovals: pendingApprovals(),
        failedTurns: failedTurns(),
      };
    },
    (input) => {
      if (!input) return;
      dynamicIslandCoordinator.replaceServer(input);
      publishDynamicIslandPresentation();
    },
  );

  createEffect(
    () => ({ action: pendingIslandAction(), ready: loaded() }),
    ({ action, ready }) => {
      if (!action) return;
      // The bridge that published the handoff is still mounted when the signal
      // changes; consuming or clearing it here would drop the intent before the
      // switch lands.
      if (action === publishedAction) return;
      if (activeServerId() !== action.serverId) {
        // Another server landed instead - the selection was superseded, or the
        // user moved on. The intent named a server that is no longer coming.
        setPendingIslandAction(null);
        return;
      }
      // The action opens a message or a failure inside this workspace, so it has
      // to wait for the workspace. Acting on a half-loaded scope reads a agent list
      // and a conversation window that are still empty.
      if (!ready) return;
      setPendingIslandAction(null);
      void handleDynamicIslandAction(action).catch(() => undefined);
    },
  );

  onSettled(() => {
    if (platform.landingPreview) return;
    return window.openbot.dynamicIsland.onAction((action) => {
      void handleDynamicIslandAction(action).catch((error) => {
        toast.error("Could not open this remote item", {
          description: error instanceof Error ? error.message : String(error),
        });
      });
    });
  });

  async function handleDynamicIslandAction(action: DynamicIslandAction): Promise<void> {
    if (action.type === "open-app") return;
    if (action.type === "answer-prompt") {
      dynamicIslandCoordinator.resolveAction(action);
      const prompt = pendingPrompts()[action.agentId];
      if (prompt?.type === "prompt" && String(prompt.requestId) === String(action.requestId)) {
        setPendingPrompts((current) => ({ ...current, [action.agentId]: undefined }));
        setSubmittedPromptRequests((current) => ({
          ...current,
          [action.agentId]: promptRequestKey(prompt.turnId, prompt.requestId) ?? undefined,
        }));
      }
      publishDynamicIslandPresentation();
      return;
    }
    if (action.type === "respond-approval") {
      dynamicIslandCoordinator.resolveAction(action);
      setPendingApprovals((current) => {
        const approval = current[action.agentId];
        return approval && String(approval.requestId) === String(action.requestId)
          ? { ...current, [action.agentId]: undefined }
          : current;
      });
      publishDynamicIslandPresentation();
      return;
    }
    if (activeServerId() !== action.serverId) {
      // The switch replaces this bridge along with the rest of the scope, so the
      // action is handed to the one that lands rather than finished here against
      // domains that are about to be disposed.
      publishedAction = action;
      setPendingIslandAction(action);
      // A newer action may have replaced this one while the selection was in
      // flight, and being superseded is exactly why that selection returns
      // false. Clearing unconditionally would delete the newer intent before
      // its own switch lands.
      if (!(await selectServer(action.serverId, false)) && pendingIslandAction() === action) {
        setPendingIslandAction(null);
      }
      return;
    }
    if (!loaded()) {
      // The right workspace, but it has not filled yet. `selectAgent` against an
      // empty agent list and a read against an empty conversation are the same
      // half-loaded scope the handoff effect above already waits out, so this
      // action joins it there. Nothing disposes this bridge in the meantime, so
      // it is the one that consumes its own entry once `loaded()` turns true -
      // which is why `publishedAction` stays untouched.
      setPendingIslandAction(action);
      return;
    }
    selectAgent(action.agentId);
    if (action.type === "open-message") await openAgentMessage(action.agentId, action.messageId);
    if (action.type === "open-failure") {
      try {
        await window.openbot.agent.acknowledgeFailedTurn({ agentId: action.agentId, turnId: action.turnId });
      } catch (error) {
        appendUiError(action.agentId, error, "Acknowledge failed", action.serverId);
        return;
      }
      setFailedTurns((current) =>
        current[action.agentId] === action.turnId ? withoutAgent(current, action.agentId) : current,
      );
      dynamicIslandCoordinator.resolveAction(action);
      publishDynamicIslandPresentation();
    }
  }

  return null;
}
