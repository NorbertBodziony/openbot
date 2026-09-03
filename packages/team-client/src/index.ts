export type TeamClientFetch = typeof globalThis.fetch;

export type TeamClientWebSocketFactory = (url: string, protocols?: string | string[]) => WebSocket;

export interface TeamClientPlatform {
  fetch: TeamClientFetch;
  openWebSocket: TeamClientWebSocketFactory;
}

export interface TeamClientSessionStore {
  clear(): Promise<void>;
  getToken(): Promise<string | null>;
  setToken(token: string): Promise<void>;
}

export * from "@openbot/contracts/team-protocol";
export * from "./remote-directory";
export * from "./remote-recovery";
export * from "./request-id";
export * from "./webrtc-framing";
