import type { ServerSummary } from "@openbot/contracts/ipc";

export function installedSkillsRequestKey(
  botId: string | undefined,
  server: ServerSummary | undefined,
  overlayOpen: boolean,
): string {
  const supported = server?.kind !== "remote" || server.compatibility?.capabilities.includes("installed-skills");
  return `${server?.id ?? "local"}\0${botId ?? ""}\0${supported ? "supported" : "unsupported"}\0${overlayOpen ? "hidden" : "visible"}`;
}
