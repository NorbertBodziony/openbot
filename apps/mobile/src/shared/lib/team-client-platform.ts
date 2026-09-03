import type { TeamClientPlatform } from "@openbot/team-client";
import { fetch } from "expo/fetch";

export const teamClientPlatform = {
  fetch,
  openWebSocket: (url, protocols) => new WebSocket(url, protocols),
} satisfies TeamClientPlatform;
