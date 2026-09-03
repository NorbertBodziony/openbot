import type { CentralAuthUser } from "@openbot/contracts/ipc";
import { isMobileConnectDevelopmentHost, parseMobileConnectUrl } from "@openbot/contracts/mobile-connect";
import { type DynamicRecord, isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { fetch } from "expo/fetch";
import * as Crypto from "expo-crypto";
import * as Device from "expo-device";
import * as SecureStore from "expo-secure-store";

import { isAndroid, isIOS } from "@/shared/lib/platform";

const MOBILE_SESSION_KEY = "openbot.mobile.session.v1";
const MOBILE_DEVICE_ID_KEY = "openbot.mobile.device-id.v1";
const MOBILE_AUTH_REQUEST_TIMEOUT_MS = 10_000;

let mobileSessionStorageTail = Promise.resolve();

export interface MobileSession {
  apiUrl: string;
  sessionToken: string;
  user: CentralAuthUser;
}

export async function redeemMobileConnectUrl(value: string): Promise<MobileSession> {
  const payload = parseMobileConnectUrl(value);
  if (!payload) {
    throw new Error("This is not a valid OpenBot Mobile Connect code.");
  }

  let response: Response;
  let body: unknown;
  try {
    const device = await mobileDeviceIdentity();
    ({ response, body } = await withMobileAuthRequestTimeout(async (signal) => {
      const request = await fetch(new URL("/v1/mobile-auth/redeem", payload.apiUrl).toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticket: payload.ticket,
          deviceId: device.id,
          deviceName: device.name,
          platform: device.platform,
        }),
        signal,
      });
      return { response: request, body: await readResponseBody(request, signal) };
    }));
  } catch {
    const apiUrl = new URL(payload.apiUrl);
    throw new Error(
      apiUrl.protocol === "http:" && isMobileConnectDevelopmentHost(apiUrl.hostname)
        ? "OpenBot could not reach your desktop. Keep both devices on the same Wi-Fi network and allow Local Network access."
        : "OpenBot could not reach the account service. Check your connection and try again.",
    );
  }

  if (!response.ok) {
    throw new Error(apiErrorMessage(body) ?? "This Mobile Connect code is invalid or has expired.");
  }

  const session = decodeMobileSession(body, payload.apiUrl);
  await saveMobileSession(session);
  return session;
}

export async function readMobileSession(): Promise<MobileSession | null> {
  return serializeMobileSessionStorage(async () => {
    const stored = await SecureStore.getItemAsync(MOBILE_SESSION_KEY);
    if (!stored) return null;
    try {
      return decodeStoredMobileSession(JSON.parse(stored));
    } catch {
      await SecureStore.deleteItemAsync(MOBILE_SESSION_KEY);
      return null;
    }
  });
}

export async function validateMobileSession(session: MobileSession): Promise<MobileSession | null> {
  const { response, body } = await withMobileAuthRequestTimeout(async (signal) => {
    const request = await fetch(new URL("/v1/mobile-auth/session", session.apiUrl).toString(), {
      headers: { Authorization: `Bearer ${session.sessionToken}` },
      signal,
    });
    return { response: request, body: await readResponseBody(request, signal) };
  });
  if (response.status === 401) {
    await deleteMobileSessionIfCurrent(session.sessionToken);
    return null;
  }
  if (!response.ok) {
    throw new Error(apiErrorMessage(body) ?? "OpenBot could not verify this mobile session.");
  }
  const user = decodeUser(body);
  if (sameUser(user, session.user)) return session;
  const updated = { ...session, user };
  await saveMobileSessionIfCurrent(updated);
  return updated;
}

export async function logoutMobileSession(session: MobileSession): Promise<void> {
  await Promise.all([
    deleteMobileSessionIfCurrent(session.sessionToken),
    withMobileAuthRequestTimeout(async (signal) => {
      await fetch(new URL("/v1/mobile-auth/session", session.apiUrl).toString(), {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session.sessionToken}` },
        signal,
      });
    }),
  ]);
}

async function withMobileAuthRequestTimeout<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MOBILE_AUTH_REQUEST_TIMEOUT_MS);
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

async function readResponseBody(response: Response, signal: AbortSignal): Promise<DynamicRecord | null> {
  try {
    const body = await response.json();
    return isDynamicRecord(body) ? body : null;
  } catch (error) {
    if (signal.aborted) throw error;
    return null;
  }
}

async function saveMobileSession(session: MobileSession): Promise<void> {
  await serializeMobileSessionStorage(() =>
    SecureStore.setItemAsync(MOBILE_SESSION_KEY, JSON.stringify(session), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    }),
  );
}

async function saveMobileSessionIfCurrent(session: MobileSession): Promise<void> {
  await serializeMobileSessionStorage(async () => {
    const stored = await SecureStore.getItemAsync(MOBILE_SESSION_KEY);
    if (!stored) return;
    try {
      if (decodeStoredMobileSession(JSON.parse(stored)).sessionToken !== session.sessionToken) return;
    } catch {
      return;
    }
    await SecureStore.setItemAsync(MOBILE_SESSION_KEY, JSON.stringify(session), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  });
}

async function deleteMobileSessionIfCurrent(sessionToken: string): Promise<void> {
  await serializeMobileSessionStorage(async () => {
    const stored = await SecureStore.getItemAsync(MOBILE_SESSION_KEY);
    if (!stored) return;
    try {
      if (decodeStoredMobileSession(JSON.parse(stored)).sessionToken !== sessionToken) return;
    } catch {
      // Corrupt session data cannot represent a newer valid session while storage operations are serialized.
    }
    await SecureStore.deleteItemAsync(MOBILE_SESSION_KEY);
  });
}

function serializeMobileSessionStorage<T>(operation: () => Promise<T>): Promise<T> {
  const result = mobileSessionStorageTail.then(operation, operation);
  mobileSessionStorageTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function mobileDeviceIdentity(): Promise<{
  id: string;
  name: string;
  platform: "ios" | "android" | "unknown";
}> {
  let id = await SecureStore.getItemAsync(MOBILE_DEVICE_ID_KEY);
  if (!id) {
    id = Crypto.randomUUID();
    await SecureStore.setItemAsync(MOBILE_DEVICE_ID_KEY, id, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  }
  const rawName = Device.deviceName?.trim() || Device.modelName?.trim() || "Mobile device";
  const name = rawName.normalize("NFC").replace(/\p{C}/gu, "").replace(/\s+/gu, " ").slice(0, 80).trim();
  const platform = isIOS ? "ios" : isAndroid ? "android" : "unknown";
  return { id, name: name || "Mobile device", platform };
}

function decodeMobileSession(value: unknown, apiUrl: string): MobileSession {
  if (!isDynamicRecord(value) || !isString(value.sessionToken) || value.sessionToken.length > 512) {
    throw new Error("The account service returned an invalid mobile session.");
  }
  return { apiUrl, sessionToken: value.sessionToken, user: decodeUser(value.user) };
}

function decodeStoredMobileSession(value: unknown): MobileSession {
  if (!isDynamicRecord(value) || !isString(value.apiUrl)) throw new Error("Invalid stored mobile session.");
  const parsed = parseMobileConnectUrl(
    `openbot://mobile-connect?api=${encodeURIComponent(value.apiUrl)}&ticket=${"x".repeat(32)}`,
  );
  if (!parsed) throw new Error("Invalid stored account API.");
  return decodeMobileSession(value, parsed.apiUrl);
}

function decodeUser(value: unknown): CentralAuthUser {
  if (!isDynamicRecord(value) || !isString(value.id) || !isString(value.email)) {
    throw new Error("The account service returned an invalid user.");
  }
  if (value.name !== null && !isString(value.name)) throw new Error("The account service returned an invalid user.");
  if (value.avatarUrl !== null && !isString(value.avatarUrl)) {
    throw new Error("The account service returned an invalid user.");
  }
  return { id: value.id, email: value.email, name: value.name, avatarUrl: value.avatarUrl };
}

function sameUser(left: CentralAuthUser, right: CentralAuthUser): boolean {
  return (
    left.id === right.id && left.email === right.email && left.name === right.name && left.avatarUrl === right.avatarUrl
  );
}

function apiErrorMessage(value: unknown): string | null {
  if (!isDynamicRecord(value) || !isDynamicRecord(value.error) || !isString(value.error.message)) return null;
  return value.error.message.length <= 240 ? value.error.message : null;
}
