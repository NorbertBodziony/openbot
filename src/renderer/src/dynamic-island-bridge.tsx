import type { DynamicIslandAction } from "@openbot/contracts/ipc";
import { createEffect, onSettled } from "solid-js";
import { useAgents } from "./agents";
import { withoutBot } from "./app-message-projection";
import { toast } from "./components/ui";
import { useConversation } from "./conversation";
import { promptRequestKey } from "./conversation-keys";
import { useDynamicIsland } from "./dynamic-island";
import { useNavigation } from "./navigation";
import { usePlatform } from "./platform";
import { useServerSelection } from "./server-selection";
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
 * The projection is withheld until `dynamicIslandLoadedServerId()` matches the
 * active server. Without that, a switch would publish the new server's id next to
 * the previous server's turns for exactly as long as the eight loads take.
 *
 * Actions arrive for *any* server, including one that is not active, which is why
 * `handleDynamicIslandAction` may call `selectServer` before it can act. The two
 * that never need a switch - answering a prompt and responding to an approval -
 * resolve against the coordinator directly and republish, so a reply from the
 * island is reflected before the renderer has caught up.
 */
export function DynamicIslandBridge() {
  const platform = usePlatform();
  const { activeServerId } = useServers();
  const { dynamicIslandCoordinator, publishDynamicIslandPresentation } = useDynamicIsland();
  const { selectServer, dynamicIslandLoadedServerId } = useServerSelection();
  const { botList, appendUiError } = useAgents();
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
  const { selectBot, openAgentMessage } = useNavigation();

  createEffect(
    () => {
      if (platform.landingPreview) return null;
      const serverId = dynamicIslandLoadedServerId();
      if (!serverId || serverId !== activeServerId()) return null;
      return {
        serverId,
        bots: botList(),
        activeTurns: activeTurns(),
        queues: queues(),
        unreadReplies: unreadReplies(),
        unreadMessageIds: Object.fromEntries(
          Object.entries(conversationReads()).map(([botId, state]) => [botId, state.firstUnreadMessageId]),
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
      const prompt = pendingPrompts()[action.botId];
      if (prompt?.type === "prompt" && String(prompt.requestId) === String(action.requestId)) {
        setPendingPrompts((current) => ({ ...current, [action.botId]: undefined }));
        setSubmittedPromptRequests((current) => ({
          ...current,
          [action.botId]: promptRequestKey(prompt.turnId, prompt.requestId) ?? undefined,
        }));
      }
      publishDynamicIslandPresentation();
      return;
    }
    if (action.type === "respond-approval") {
      dynamicIslandCoordinator.resolveAction(action);
      setPendingApprovals((current) => {
        const approval = current[action.botId];
        return approval && String(approval.requestId) === String(action.requestId)
          ? { ...current, [action.botId]: undefined }
          : current;
      });
      publishDynamicIslandPresentation();
      return;
    }
    if (activeServerId() !== action.serverId && !(await selectServer(action.serverId, false))) return;
    selectBot(action.botId);
    if (action.type === "open-message") await openAgentMessage(action.botId, action.messageId);
    if (action.type === "open-failure") {
      try {
        await window.openbot.agent.acknowledgeFailedTurn({ botId: action.botId, turnId: action.turnId });
      } catch (error) {
        appendUiError(action.botId, error, "Acknowledge failed", action.serverId);
        return;
      }
      setFailedTurns((current) =>
        current[action.botId] === action.turnId ? withoutBot(current, action.botId) : current,
      );
      dynamicIslandCoordinator.resolveAction(action);
      publishDynamicIslandPresentation();
    }
  }

  return null;
}
