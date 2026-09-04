import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { remoteHostFingerprint } from "./remote-directory";

export interface RemoteWorkspacePreferences {
  hidden: string[];
  pinned: string[];
}

export function createWorkspacePreferences(
  apiUrl: string,
  userId: string,
  storage: { get(key: string): string | null; set(key: string, value: string): void },
) {
  const scope = remoteHostFingerprint(JSON.stringify([new URL(apiUrl).origin, userId]));
  const key = (hostId: string) => `openbot.workspace.v1.${scope}.${remoteHostFingerprint(hostId)}`;
  return {
    read(hostId: string): RemoteWorkspacePreferences {
      const stored = storage.get(key(hostId));
      if (!stored) return { hidden: [], pinned: [] };
      return decodePreferences(JSON.parse(stored));
    },
    write(hostId: string, value: RemoteWorkspacePreferences): void {
      storage.set(key(hostId), JSON.stringify({ version: 1, ...value }));
    },
  };
}

function decodePreferences(value: unknown): RemoteWorkspacePreferences {
  if (
    !isDynamicRecord(value) ||
    value.version !== 1 ||
    !Array.isArray(value.hidden) ||
    !value.hidden.every(isString) ||
    !Array.isArray(value.pinned) ||
    !value.pinned.every(isString)
  ) {
    throw new Error("The saved chat preferences could not be read.");
  }
  return { hidden: value.hidden, pinned: value.pinned };
}
