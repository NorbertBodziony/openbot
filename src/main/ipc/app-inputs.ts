import type { AgentProviderId, MacPermissionId } from "@openbot/contracts/ipc";

export function parseProvider(input: unknown): AgentProviderId {
  if (!input || typeof input !== "object") throw new Error("Setup input is required.");
  const provider = Reflect.get(input, "preferredProvider");
  if (provider !== "codex" && provider !== "claude") throw new Error("Unknown provider.");
  return provider;
}

export function parseMacPermission(input: unknown): MacPermissionId {
  if (input !== "screen-recording" && input !== "accessibility") {
    throw new Error("Unknown macOS permission.");
  }
  return input;
}
