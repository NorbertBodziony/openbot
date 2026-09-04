import { useMobileWorkspace } from "@/features/workspace/context/mobile-workspace-context";

export function useBotActivity(botId: string) {
  const { activityByServer, activeServer } = useMobileWorkspace();
  return activeServer.state === "online" ? activityByServer[activeServer.id]?.[botId] : undefined;
}
