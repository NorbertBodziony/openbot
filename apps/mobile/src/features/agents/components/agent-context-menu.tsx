import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { Link, router } from "expo-router";
import { useRef } from "react";
import { Alert } from "react-native";

import { useBotPinTransition } from "@/features/agents/components/agent-pin-transition";
import { type MobileBot, useMobileWorkspace } from "@/features/workspace/context/mobile-workspace-context";
import { isIOS } from "@/shared/lib/platform";

export function useBotContextMenu(bot: MobileBot) {
  const { deleteBot, duplicateBot, hideBot, markBotRead, markBotUnread, pinnedBotIds, unreadBotIds } =
    useMobileWorkspace();
  const { toggleBotPinAnimated } = useBotPinTransition();
  const isPinned = pinnedBotIds.includes(bot.id);
  const isUnread = unreadBotIds.includes(bot.id);
  const actionPending = useRef(false);

  async function runBotAction(action: "delete" | "duplicate"): Promise<void> {
    if (actionPending.current) return;
    actionPending.current = true;
    try {
      if (action === "delete") await deleteBot(bot.id);
      else await duplicateBot(bot.id);
      if (isIOS) {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      }
    } catch (error) {
      Alert.alert(
        action === "delete" ? "Could not delete bot" : "Could not duplicate bot",
        error instanceof Error ? error.message : "The server could not complete this action. Please try again.",
      );
    } finally {
      actionPending.current = false;
    }
  }

  const handlePin = () => toggleBotPinAnimated(bot.id);

  const handleCopyId = () => {
    void Clipboard.setStringAsync(bot.id).then(() => {
      if (isIOS) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    });
  };

  const handleDelete = () => {
    Alert.alert(`Delete ${bot.name}?`, "This removes the bot from this server.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          void runBotAction("delete");
        },
      },
    ]);
  };

  return (
    <Link.Menu>
      <Link.MenuAction
        icon={isUnread ? "envelope.open" : "envelope.badge"}
        onPress={() => {
          if (isUnread) markBotRead(bot.id);
          else markBotUnread(bot.id);
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
          hideBot(bot.id);
          if (isIOS) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        }}
      >
        Hide
      </Link.MenuAction>
      <Link.Menu icon="ellipsis" title="More">
        <Link.MenuAction
          icon="pencil"
          onPress={() => router.push({ pathname: "/edit-agent/[agentId]", params: { agentId: bot.id } })}
        >
          Edit
        </Link.MenuAction>
        <Link.MenuAction icon="doc.on.doc" onPress={handleCopyId}>
          Copy ID
        </Link.MenuAction>
        <Link.MenuAction
          icon="plus.square.on.square"
          onPress={() => {
            void runBotAction("duplicate");
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
