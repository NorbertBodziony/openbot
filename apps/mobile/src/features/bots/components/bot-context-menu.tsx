import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { Link } from "expo-router";
import { Alert } from "react-native";

import { useBotPinTransition } from "@/features/bots/components/bot-pin-transition";
import { type MobileBot, useMobileWorkspace } from "@/features/workspace/context/mobile-workspace-context";
import { isIOS } from "@/shared/lib/platform";

export function useBotContextMenu(bot: MobileBot) {
  const { deleteBot, duplicateBot, hideBot, markBotRead, markBotUnread, pinnedBotIds, unreadBotIds } =
    useMobileWorkspace();
  const { toggleBotPinAnimated } = useBotPinTransition();
  const isPinned = pinnedBotIds.includes(bot.id);
  const isUnread = unreadBotIds.includes(bot.id);

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
          deleteBot(bot.id);
          if (isIOS) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
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
        <Link.MenuAction icon="doc.on.doc" onPress={handleCopyId}>
          Copy ID
        </Link.MenuAction>
        <Link.MenuAction
          icon="plus.square.on.square"
          onPress={() => {
            duplicateBot(bot.id);
            if (isIOS) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
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
