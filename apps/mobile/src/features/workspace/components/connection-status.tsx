import { Typography } from "heroui-native";
import { useThemeColor } from "heroui-native/hooks";
import { WifiOff } from "lucide-react-native";
import { View } from "react-native";

import type { MobileServer } from "@/features/workspace/model/workspace-types";

export function ConnectionStatus({ server }: { server: MobileServer | undefined }) {
  const muted = useThemeColor("muted");
  if (!server || server.state === "online") return null;
  return (
    <View className="px-5 pb-3 pt-1">
      <View className="flex-row items-center gap-2 rounded-2xl bg-control px-3 py-2.5">
        <WifiOff color={String(muted)} size={17} strokeWidth={1.8} />
        <Typography.Paragraph type="body-xs" className="min-w-0 flex-1 text-text-secondary">
          {server.connectionMessage ?? (server.state === "connecting" ? "Connecting…" : "This server is offline.")}
        </Typography.Paragraph>
      </View>
    </View>
  );
}
