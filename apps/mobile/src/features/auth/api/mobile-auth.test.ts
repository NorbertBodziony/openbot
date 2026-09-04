import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logoutMobileSession, type MobileSession, readMobileSession } from "./mobile-auth";

// The native Keychain and HTTP transport are the boundary; exercise the real session storage logic.
const native = vi.hoisted(() => ({ storage: new Map<string, string>(), fetch: vi.fn<typeof fetch>() }));
vi.mock("expo/fetch", () => ({ fetch: native.fetch }));
vi.mock("expo-crypto", () => ({}));
vi.mock("expo-device", () => ({}));
vi.mock("@/shared/lib/platform", () => ({ isIOS: true, isAndroid: false }));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async (key: string) => native.storage.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    native.storage.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    native.storage.delete(key);
  },
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "when-unlocked-this-device-only",
}));

const key = "openbot.mobile.session.v1";
const session: MobileSession = {
  apiUrl: "https://api.openbot.run",
  sessionToken: "test-session-token",
  user: { id: "user", email: "user@example.com", name: null, avatarUrl: null },
};

beforeEach(() => {
  native.storage.clear();
  native.storage.set(key, JSON.stringify(session));
  native.fetch.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("mobile session revocation", () => {
  it.each(["network", "timeout", 500, 401] as const)(
    "retains the credential after %s so logout can be retried",
    async (failure) => {
      vi.useFakeTimers();
      failNextLogout(failure);
      native.fetch.mockResolvedValueOnce(Response.json(session.user));
      const result = logoutMobileSession(session).then(
        () => "signed-out",
        () => "failed",
      );
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await result).toBe("failed");
      expect(await readMobileSession()).toEqual(session);

      native.fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
      await logoutMobileSession(session);
      expect(await readMobileSession()).toBeNull();
    },
  );

  it.each(["network", "timeout", 500, 401] as const)(
    "finishes logout immediately when %s hides a completed server revocation",
    async (failure) => {
      vi.useFakeTimers();
      failNextLogout(failure);
      native.fetch.mockResolvedValueOnce(Response.json({ error: { code: "unauthorized" } }, { status: 401 }));
      const result = logoutMobileSession(session).then(
        () => "signed-out",
        () => "failed",
      );
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await result).toBe("signed-out");
      expect(await readMobileSession()).toBeNull();
      expect(native.fetch).toHaveBeenLastCalledWith(
        "https://api.openbot.run/v1/mobile-auth/session",
        expect.objectContaining({
          headers: { Authorization: "Bearer test-session-token" },
        }),
      );
    },
  );

  it.each(["network", 500, "malformed"] as const)(
    "keeps the credential when the follow-up session check fails (%s)",
    async (failure) => {
      failNextLogout(500);
      native.fetch.mockImplementationOnce(async () => {
        if (failure === "network") throw new TypeError("Network unavailable");
        return failure === "malformed" ? Response.json({}) : new Response(null, { status: failure });
      });
      await expect(logoutMobileSession(session)).rejects.toThrow("Could not confirm sign-out.");
      expect(await readMobileSession()).toEqual(session);
    },
  );

  it("does not clear a newer login when the follow-up check confirms the old token was revoked", async () => {
    failNextLogout(401);
    let confirm!: (response: Response) => void;
    native.fetch.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          confirm = resolve;
        }),
    );
    const pending = logoutMobileSession(session).then(
      () => "signed-out",
      () => "failed",
    );
    await vi.waitFor(() => expect(native.fetch).toHaveBeenCalledTimes(2));
    const replacement = { ...session, sessionToken: "new-test-session-token" };
    native.storage.set(key, JSON.stringify(replacement));
    confirm(Response.json({ error: { code: "unauthorized" } }, { status: 401 }));
    expect(await pending).toBe("signed-out");
    expect(await readMobileSession()).toEqual(replacement);
  });

  it.each([false, true])("waits for confirmed revocation and preserves a newer login (%s)", async (newLogin) => {
    let confirm!: (response: Response) => void;
    native.fetch.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          confirm = resolve;
        }),
    );
    const pending = logoutMobileSession(session);
    await vi.waitFor(() => expect(native.fetch).toHaveBeenCalledOnce());
    expect(await readMobileSession()).toEqual(session);
    const replacement = { ...session, sessionToken: "new-test-session-token" };
    if (newLogin) native.storage.set(key, JSON.stringify(replacement));
    confirm(new Response(null, { status: 204 }));
    await pending;
    expect(await readMobileSession()).toEqual(newLogin ? replacement : null);
    expect(native.fetch).toHaveBeenCalledWith(
      "https://api.openbot.run/v1/mobile-auth/session",
      expect.objectContaining({
        method: "DELETE",
        headers: { Authorization: "Bearer test-session-token" },
      }),
    );
  });
});

function failNextLogout(failure: "network" | "timeout" | 500 | 401): void {
  native.fetch.mockImplementationOnce(async (_input, init) => {
    if (failure === "network") throw new TypeError("Network request failed");
    if (failure === "timeout") {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("Request aborted")), { once: true });
      });
    }
    return Response.json({ error: { message: "Server failure" } }, { status: failure });
  });
}
