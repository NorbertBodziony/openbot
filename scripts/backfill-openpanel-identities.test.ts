import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { applyBackfill, buildBackfillUpdates, runBackfill } from "./backfill-openpanel-identities";

describe("OpenPanel identity backfill", () => {
  it("updates only existing profiles with missing or stale email", () => {
    expect(
      buildBackfillUpdates(
        [
          { id: "account-1", email: " Person@EXAMPLE.COM " },
          { id: "account-2", email: "two@example.com" },
        ],
        [
          { profileId: "account-1", email: null },
          { profileId: "account-2", email: "old@example.com" },
          { profileId: "account-3", email: null },
        ],
      ),
    ).toEqual([
      { profileId: "account-1", email: "person@example.com" },
      { profileId: "account-2", email: "two@example.com" },
    ]);
  });

  it("rejects duplicate profile ids and malformed emails", () => {
    expect(() =>
      buildBackfillUpdates(
        [{ id: "account-1", email: "person@example.com" }],
        [
          { profileId: "account-1", email: null },
          { profileId: "account-1", email: null },
        ],
      ),
    ).toThrow("Duplicate OpenPanel profile id");
    expect(() =>
      buildBackfillUpdates([{ id: "account-1", email: "invalid" }], [{ profileId: "account-1", email: null }]),
    ).toThrow("Invalid auth user email");
    expect(() =>
      buildBackfillUpdates(
        [{ id: "account-1", email: "person@example.com" }],
        [{ profileId: "unmatched-account", email: "invalid" }],
      ),
    ).toThrow("Invalid OpenPanel profile email");
  });

  it("keeps dry runs read-only", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-openpanel-backfill-test-"));
    try {
      await writeFile(
        join(directory, "users.json"),
        JSON.stringify([{ id: "account-1", email: "person@example.com" }]),
      );
      await writeFile(join(directory, "profiles.json"), JSON.stringify([{ profileId: "account-1", email: null }]));
      const fetcher = vi.fn<typeof fetch>();

      const summary = await runBackfill({
        authUsersPath: join(directory, "users.json"),
        openPanelProfilesPath: join(directory, "profiles.json"),
        apply: false,
        fetcher,
      });

      expect(summary).toEqual({ authUsers: 1, openPanelProfiles: 1, matchedProfiles: 1, updates: 1, applied: 0 });
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retries transient failures and sends identify payloads without event data", async () => {
    let attempts = 0;
    const requests: unknown[] = [];
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      attempts += 1;
      requests.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: attempts < 3 ? 503 : 202 });
    });
    const sleep = vi.fn(async () => undefined);

    expect(
      await applyBackfill([{ profileId: "account-1", email: "person@example.com" }], {
        apiUrl: "https://analytics.openbot.run/api",
        clientId: "client-id",
        clientSecret: "client-secret",
        fetcher,
        sleep,
      }),
    ).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(requests[0]).toEqual({
      type: "identify",
      payload: { profileId: "account-1", email: "person@example.com" },
    });
    expect(JSON.stringify(requests[0])).not.toContain("track");
  });

  it("stops immediately on an authorization failure", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 401 }));
    const sleep = vi.fn(async () => undefined);

    await expect(
      applyBackfill([{ profileId: "account-1", email: "person@example.com" }], {
        clientId: "client-id",
        clientSecret: "client-secret",
        fetcher,
        sleep,
      }),
    ).rejects.toThrow("HTTP 401");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });
});
