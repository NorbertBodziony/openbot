import { type RemoteHostKeyStore, remoteHostFingerprint } from "@openbot/team-client";
import * as SecureStore from "expo-secure-store";

export function trustedHostKeys(apiUrl: string, userId: string): RemoteHostKeyStore {
  const scope = remoteHostFingerprint(JSON.stringify([new URL(apiUrl).origin, userId]));
  const key = (hostId: string) => `openbot.host-key.v1.${scope}.${remoteHostFingerprint(hostId)}`;
  return {
    get: (hostId) => SecureStore.getItemAsync(key(hostId)),
    set: (hostId, publicKey) =>
      SecureStore.setItemAsync(key(hostId), publicKey, {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      }),
  };
}
