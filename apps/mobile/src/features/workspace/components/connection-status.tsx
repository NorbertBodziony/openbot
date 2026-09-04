import { REMOTE_RETRY_LIMIT } from "@openbot/team-client";
import { Typography } from "heroui-native";
import { View } from "react-native";

import { ConnectionCountdown } from "@/features/workspace/components/connection-countdown";
import { AnimatedCounter } from "@/features/workspace/components/connection-counter";
import { ConnectionStatusReveal } from "@/features/workspace/components/connection-status-reveal";
import type { MobileServer } from "@/features/workspace/model/workspace-types";

function ConnectionStatusText({ server }: { server: MobileServer }) {
  const recovery = server.recoveryStatus;
  const reconnecting = recovery && recovery.phase !== "online";
  const title = reconnecting ? "Reconnecting" : server.state === "connecting" ? "Connecting…" : "Offline";
  const detail = reconnecting ? `Attempt ${recovery.attempt}/${REMOTE_RETRY_LIMIT}` : server.connectionMessage;
  const remainingSeconds = reconnecting ? recovery.remainingSeconds : null;

  return (
    <View
      accessible
      accessibilityLabel={[
        title,
        detail,
        remainingSeconds !== null && remainingSeconds > 0 ? `Retry in ${remainingSeconds} seconds` : null,
      ]
        .filter(Boolean)
        .join(". ")}
      className="flex-row items-center justify-center px-5 pb-1 pt-1"
    >
      <Typography.Paragraph
        type="body-xs"
        className="shrink text-text-secondary"
        numberOfLines={1}
        maxFontSizeMultiplier={1.2}
      >
        {reconnecting ? `${title} · ` : detail ? `${title} · ${detail}` : title}
      </Typography.Paragraph>
      {reconnecting ? (
        <>
          <AnimatedCounter value={String(recovery.attempt)} />
          <Typography.Paragraph type="body-xs" className="text-text-secondary" maxFontSizeMultiplier={1.2}>
            /{REMOTE_RETRY_LIMIT}
          </Typography.Paragraph>
        </>
      ) : null}
      <ConnectionCountdown seconds={remainingSeconds} />
    </View>
  );
}

export function ConnectionStatus({ server }: { server: MobileServer | undefined }) {
  return (
    <ConnectionStatusReveal value={server && server.state !== "online" ? server : null} collapseOnHide>
      {(displayed) => <ConnectionStatusText server={displayed} />}
    </ConnectionStatusReveal>
  );
}
