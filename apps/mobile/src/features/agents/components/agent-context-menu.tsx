import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { Link, router } from "expo-router";
import { useRef } from "react";
import { Alert } from "react-native";

import { useAgentPinTransition } from "@/features/agents/components/agent-pin-transition";
import { type MobileAgent, useMobileWorkspace } from "@/features/workspace/context/mobile-workspace-context";
import { isIOS } from "@/shared/lib/platform";

export function useAgentContextMenu(agent: MobileAgent) {
  const { deleteAgent, duplicateAgent, hideAgent, markAgentRead, markAgentUnread, pinnedAgentIds, unreadAgentIds } =
    useMobileWorkspace();
  const { toggleAgentPinAnimated } = useAgentPinTransition();
  const isPinned = pinnedAgentIds.includes(agent.id);
  const isUnread = unreadAgentIds.includes(agent.id);
  const actionPending = useRef(false);

  async function runAgentAction(action: "delete" | "duplicate"): Promise<void> {
    if (actionPending.current) return;
    actionPending.current = true;
    try {
      if (action === "delete") await deleteAgent(agent.id);
      else await duplicateAgent(agent.id);
      if (isIOS) {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      }
    } catch (error) {
      Alert.alert(
        action === "delete" ? "Could not delete agent" : "Could not duplicate agent",
        error instanceof Error ? error.message : "The server could not complete this action. Please try again.",
      );
    } finally {
      actionPending.current = false;
    }
  }

  const handlePin = () => toggleAgentPinAnimated(agent.id);

  const handleCopyId = () => {
    void Clipboard.setStringAsync(agent.id).then(() => {
      if (isIOS) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    });
  };

  const handleDelete = () => {
    Alert.alert(`Delete ${agent.name}?`, "This removes the agent from this server.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          void runAgentAction("delete");
        },
      },
    ]);
  };

  return (
    <Link.Menu>
      <Link.MenuAction
        icon={isUnread ? "envelope.open" : "envelope.badge"}
        onPress={() => {
          if (isUnread) markAgentRead(agent.id);
          else markAgentUnread(agent.id);
          if (isIOS) void Haptics.selectionAsync();
        }}
      >
        {isUnread ? "Mark read" : "Mark unread"}
      </Link.MenuAction>
      <Link.MenuAction icon={isPinned ? "pin.slash" : "pin"} isOn={isPinned} onPress={handlePin}>
        {isPinned ? "Unpin" : "Pin"}
      </Link.MenuAction>
      <Link.MenuAction
        icon="eye.slash"
        onPress={() => {
          hideAgent(agent.id);
          if (isIOS) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        }}
      >
        Hide
      </Link.MenuAction>
      <Link.Menu icon="ellipsis" title="More">
        <Link.MenuAction
          icon="pencil"
          onPress={() => router.push({ pathname: "/edit-agent/[agentId]", params: { agentId: agent.id } })}
        >
          Edit
        </Link.MenuAction>
        <Link.MenuAction icon="doc.on.doc" onPress={handleCopyId}>
          Copy ID
        </Link.MenuAction>
        <Link.MenuAction
          icon="plus.square.on.square"
          onPress={() => {
            void runAgentAction("duplicate");
          }}
        >
          Duplicate
        </Link.MenuAction>
        <Link.MenuAction destructive icon="trash" onPress={handleDelete}>
          Delete
        </Link.MenuAction>
      </Link.Menu>
    </Link.Menu>
  );
}
