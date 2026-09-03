// @vitest-environment node

import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TeamStore } from "./team-store";

const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("TeamStore", () => {
  it("rejects server names above the shared limit", async () => {
    const { store } = await createStore();

    await expect(
      store.configureWithAccount("x".repeat(INPUT_LIMITS.serverName + 1), {
        id: "owner-account",
        email: "owner@example.com",
        name: "Owner",
        avatarUrl: null,
      }),
    ).rejects.toThrow(`${INPUT_LIMITS.serverNameMin} to ${INPUT_LIMITS.serverName} characters`);
    expect(store.configured).toBe(false);
  });

  it("accepts legacy account names outside the editable profile limits", async () => {
    const { store } = await createStore();

    await store.configureWithAccount("Studio Mac", {
      id: "owner-account",
      email: "owner@example.com",
      name: "x",
      avatarUrl: null,
    });

    expect(store.listMembers()[0]?.name).toBe("x");
  });

  it("creates an owner and authenticates without storing the password", async () => {
    const { store, path } = await createStore();
    const identity = await store.configure("Studio Mac", "owner", "correct horse battery");
    expect(identity.serverName).toBe("Studio Mac");
    const login = await store.login("owner", "correct horse battery");
    expect(login.member.role).toBe("owner");
    expect(store.authenticate(login.sessionToken)?.username).toBe("owner");
    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain("correct horse battery");
    expect(raw).not.toContain(login.sessionToken);
  });

  it("recovers the persistence queue after a write failure", async () => {
    const { store, path } = await createStore();
    const identity = await store.configure("Studio Mac", "owner", "correct horse battery");
    const root = path.slice(0, -"/team.json".length);
    const unavailableRoot = `${root}-unavailable`;

    await rename(root, unavailableRoot);
    await expect(store.setEnabledOnLaunch(identity.serverId, true)).rejects.toThrow();
    await rename(unavailableRoot, root);

    await expect(store.setEnabledOnLaunch(identity.serverId, false)).resolves.toBeUndefined();
    expect((await readStoredHost(path)).enabledOnLaunch).toBe(false);
  });

  it("stores, restores, replaces, and removes a validated server logo", async () => {
    const { store, path } = await createStore();
    const firstLogo = {
      mimeType: "image/png" as const,
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    };
    const identity = await store.configureWithAccount(
      "Studio Mac",
      {
        id: "owner-account",
        email: "owner@example.com",
        name: "Owner",
        avatarUrl: null,
      },
      firstLogo,
    );
    const firstStoredLogo = store.resolveLogo();

    expect(identity.logoVersion).toBe(firstStoredLogo?.version);
    expect(firstStoredLogo?.mimeType).toBe("image/png");
    await expect(readFile(firstStoredLogo?.path ?? "")).resolves.toEqual(Buffer.from(firstLogo.bytes));
    const raw = await readStoredHost(path);
    expect(raw.serverLogo).toEqual({ version: firstStoredLogo?.version, mimeType: "image/png" });
    expect(raw.serverLogo).not.toHaveProperty("bytes");

    const restored = new TeamStore(path);
    await restored.initialize();
    expect(restored.resolveLogo()).toEqual(firstStoredLogo);

    const previousServerId = identity.serverId;
    const updated = await restored.updateIdentity({
      serverName: "Studio Team",
      logo: { mimeType: "image/jpeg", bytes: new Uint8Array([0xff, 0xd8, 0xff]) },
    });
    expect(updated.serverId).toBe(previousServerId);
    expect(updated.serverName).toBe("Studio Team");
    expect(updated.logoVersion).not.toBe(firstStoredLogo?.version);
    await expect(readFile(firstStoredLogo?.path ?? "")).rejects.toMatchObject({ code: "ENOENT" });

    const replacement = restored.resolveLogo();
    expect(replacement?.mimeType).toBe("image/jpeg");
    await restored.updateIdentity({ logo: null });
    expect(restored.getIdentity()?.logoVersion).toBeNull();
    expect(restored.resolveLogo()).toBeNull();
    await expect(readFile(replacement?.path ?? "")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects invalid server logo data without creating the team", async () => {
    const { store } = await createStore();

    await expect(
      store.configureWithAccount(
        "Studio Mac",
        {
          id: "owner-account",
          email: "owner@example.com",
          name: "Owner",
          avatarUrl: null,
        },
        { mimeType: "image/png", bytes: new Uint8Array([0xff, 0xd8, 0xff]) },
      ),
    ).rejects.toThrow("valid PNG, JPEG, or WebP");
    expect(store.configured).toBe(false);
  });

  it("uses an invitation once and preserves its role", async () => {
    const { store } = await createStore();
    await store.configure("Studio Mac", "owner", "correct horse battery");
    const invite = await store.createInvite("member");
    const joined = await store.acceptInvite(invite.token, "alice", "a secure team password");
    expect(joined.member.role).toBe("member");
    await expect(store.acceptInvite(invite.token, "bob", "another secure password")).rejects.toThrow(
      "invalid or expired",
    );
  });

  it("previews an invitation without consuming it", async () => {
    const { store } = await createStore();
    await store.configure("Studio Mac", "owner", "correct horse battery");
    const invite = await store.createInvite("admin", "alice@example.com");

    expect(store.previewInvite(invite.token)).toEqual({
      role: "admin",
      expiresAt: invite.expiresAt,
      emailBound: true,
    });
    await expect(
      store.acceptInviteWithAccount(invite.token, {
        id: "alice-account",
        email: "alice@example.com",
        name: "Alice",
        avatarUrl: null,
      }),
    ).resolves.toBeDefined();
    expect(() => store.previewInvite(invite.token)).toThrow("invalid or expired");
  });

  it("rejects expired and revoked invitation previews", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T10:00:00.000Z"));
    const { store } = await createStore();
    await store.configure("Studio Mac", "owner", "correct horse battery");
    const expired = await store.createInvite("member");
    const revoked = await store.createInvite("admin");
    await store.revokeInvite(revoked.id);

    expect(() => store.previewInvite(revoked.token)).toThrow("invalid or expired");
    vi.setSystemTime(new Date("2026-08-21T10:00:00.001Z"));
    expect(() => store.previewInvite(expired.token)).toThrow("invalid or expired");
  });

  it("uses the verified OpenBot email as the team identity", async () => {
    const { store } = await createStore();
    await store.configureWithAccount("Studio Mac", {
      id: "owner-account",
      email: "owner@example.com",
      name: "Owner",
      avatarUrl: null,
    });
    const invite = await store.createInvite("member", "alice@example.com");
    const joined = await store.acceptInviteWithAccount(invite.token, {
      id: "alice-account",
      email: "ALICE@example.com",
      name: "Alice",
      avatarUrl: null,
    });

    expect(joined.member).toMatchObject({
      email: "alice@example.com",
      username: "alice@example.com",
      role: "member",
    });
    expect(store.authenticate(joined.sessionToken)?.email).toBe("alice@example.com");
  });

  it("uses control-plane membership IDs for remote sessions and direct-message recipients", async () => {
    const { store, path } = await createStore();
    await store.configureWithAccount("Studio Mac", {
      id: "owner-account",
      email: "owner@example.com",
      name: "Owner",
      avatarUrl: null,
    });
    const ownerMembershipId = store.getOwnerMemberId();
    expect(ownerMembershipId).toBeTruthy();
    await store.syncRemoteDirectory(store.getIdentity()?.serverId ?? "missing-host", [
      {
        membershipId: ownerMembershipId ?? "missing-owner",
        email: "owner@example.com",
        name: "Owner",
        avatarUrl: null,
        role: "owner",
        status: "active",
        createdAt: 1_900_000_000_000,
      },
      {
        membershipId: "d1-member",
        email: "alice@example.com",
        name: "Alice",
        avatarUrl: null,
        role: "member",
        status: "active",
        createdAt: 1_900_000_000_000,
      },
    ]);

    const remote = store.openRemoteSession({
      sessionId: "remote-session",
      membershipId: "d1-member",
      userId: "alice-account",
      role: "member",
    });
    expect(remote.member).toMatchObject({ id: "d1-member", email: "alice@example.com", name: "Alice" });
    expect(store.listSessions()).toEqual([
      expect.objectContaining({ id: "remote-session", memberId: "d1-member", username: "alice@example.com" }),
    ]);
    await store.revokeSession("remote-session");
    expect(store.listSessions()).toHaveLength(0);
    expect(store.authenticate(remote.sessionToken)).toBeNull();
    expect(store.getMember("d1-member")).toMatchObject({ email: "alice@example.com", disabled: false });

    const restored = new TeamStore(path);
    await restored.initialize();
    expect(restored.getMember("d1-member")).toMatchObject({ email: "alice@example.com", disabled: false });
  });

  it("maps a migrated control-plane owner to the verified local owner", async () => {
    const { store } = await createStore();
    await store.configureWithAccount("Studio Mac", {
      id: "owner-account",
      email: "owner@example.com",
      name: "Owner",
      avatarUrl: null,
    });
    const ownerSession = await store.loginWithAccount({
      id: "owner-account",
      email: "owner@example.com",
      name: "Owner",
      avatarUrl: null,
    });
    const previousOwnerId = store.getOwnerMemberId();
    await store.syncRemoteDirectory(store.getIdentity()?.serverId ?? "missing-host", [
      {
        membershipId: "host-1:owner",
        email: "owner@example.com",
        name: "Owner",
        avatarUrl: null,
        role: "owner",
        status: "active",
        createdAt: 1_900_000_000_000,
      },
    ]);

    expect(previousOwnerId).not.toBe("host-1:owner");
    expect(store.getOwnerMemberId()).toBe("host-1:owner");
    expect(store.getMember("host-1:owner")).toMatchObject({ email: "owner@example.com", role: "owner" });
    expect(store.authenticateSession(ownerSession.sessionToken)?.member.id).toBe("host-1:owner");
  });

  it("uses verified Signal claims when the local remote directory is stale", async () => {
    const { store } = await createStore();
    await store.configureWithAccount("Studio Mac", {
      id: "owner-account",
      email: "owner@example.com",
      name: "Owner",
      avatarUrl: null,
    });
    const ownerMembershipId = store.getOwnerMemberId();
    await store.syncRemoteDirectory(store.getIdentity()?.serverId ?? "missing-host", [
      {
        membershipId: ownerMembershipId ?? "missing-owner",
        email: "owner@example.com",
        name: "Owner",
        avatarUrl: null,
        role: "owner",
        status: "active",
        createdAt: 1_900_000_000_000,
      },
      {
        membershipId: "remote-member",
        email: "member@example.com",
        name: "Member",
        avatarUrl: null,
        role: "member",
        status: "revoked",
        createdAt: 1_900_000_000_000,
      },
    ]);

    const remote = store.openRemoteSession({
      sessionId: "verified-session",
      membershipId: "remote-member",
      userId: "member-account",
      role: "admin",
    });

    expect(remote.member).toMatchObject({ id: "remote-member", role: "admin", disabled: false });
    expect(store.getMember("remote-member")).toMatchObject({ role: "member", disabled: true });
  });

  it("lets an existing account member connect another client with an invitation", async () => {
    const { store } = await createStore();
    await store.configureWithAccount("Studio Mac", {
      id: "owner-account",
      email: "owner@example.com",
      name: "Owner",
      avatarUrl: null,
    });
    const invite = await store.createInvite("member");

    const connected = await store.acceptInviteWithAccount(invite.token, {
      id: "owner-account",
      email: "OWNER@example.com",
      name: "Owner on another Mac",
      avatarUrl: null,
    });

    expect(connected.member).toMatchObject({
      email: "owner@example.com",
      name: "Owner on another Mac",
      role: "owner",
    });
    expect(store.listMembers()).toHaveLength(1);
    expect(store.authenticate(connected.sessionToken)?.email).toBe("owner@example.com");
    expect(() => store.previewInvite(invite.token)).toThrow("invalid or expired");
  });

  it("synchronizes and persists the account avatar for team members", async () => {
    const { store, path } = await createStore();
    await store.configureWithAccount("Studio Mac", {
      id: "owner-account",
      email: "owner@example.com",
      name: "Owner",
      avatarUrl: null,
    });

    await expect(
      store.syncAccount({
        id: "owner-account",
        email: "owner@example.com",
        name: "Owner Name",
        avatarUrl: "https://api.openbot.run/v1/avatars/owner-account?v=image-1",
      }),
    ).resolves.toBe(true);
    expect(store.listMembers()[0]).toMatchObject({
      name: "Owner Name",
      avatarUrl: "https://api.openbot.run/v1/avatars/owner-account?v=image-1",
    });

    const restored = new TeamStore(path);
    await restored.initialize();
    expect(restored.listMembers()[0]?.avatarUrl).toBe("https://api.openbot.run/v1/avatars/owner-account?v=image-1");
  });

  it("reads an old team file and backfills the private owner account ID on the next account sync", async () => {
    const { store, path } = await createStore();
    const owner = {
      id: "owner-account",
      email: "owner@example.com",
      name: "Owner",
      avatarUrl: null,
    };
    await store.configureWithAccount("Studio Mac", owner);
    const legacy = await readStoredHost(path);
    delete legacy.members?.[0]?.accountId;
    await writeFile(path, JSON.stringify(legacy));

    const restored = new TeamStore(path);
    await restored.initialize();
    expect(restored.getOwnerAnalyticsIdentity()).toBeNull();
    expect(restored.listMembers()[0]).not.toHaveProperty("accountId");

    await expect(restored.syncAccount(owner)).resolves.toBe(true);
    expect(restored.getOwnerAnalyticsIdentity()).toEqual({ id: "owner-account", email: "owner@example.com" });
    expect(restored.listMembers()[0]).not.toHaveProperty("accountId");
    const persisted = await readStoredHost(path);
    expect(persisted.members?.[0]?.accountId).toBe("owner-account");
  });

  it("keeps each account's host separate and restores it on the next sign-in", async () => {
    const { store, path } = await createStore();
    const first = { id: "account-a", email: "a@example.com", name: "A", avatarUrl: null };
    const second = { id: "account-b", email: "b@example.com", name: "B", avatarUrl: null };
    const firstIdentity = await store.configureWithAccount("Studio Mac", first, {
      mimeType: "image/png",
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    });
    const invite = await store.createInvite("member");
    await store.acceptInviteWithAccount(invite.token, {
      id: "account-c",
      email: "c@example.com",
      name: "C",
      avatarUrl: null,
    });
    const pending = await store.createInvite("admin");

    await store.activateAccount(second);
    expect(store.configured).toBe(false);
    expect(store.getIdentity()).toBeNull();
    const secondIdentity = await store.configureWithAccount("Loft Mini", second);
    expect(secondIdentity.serverId).not.toBe(firstIdentity.serverId);
    expect(store.listMembers()).toHaveLength(1);

    await store.activateAccount(first);
    expect(store.getIdentity()?.serverId).toBe(firstIdentity.serverId);
    expect(store.getIdentity()?.serverName).toBe("Studio Mac");
    expect(store.getIdentity()?.logoVersion).toBe(firstIdentity.logoVersion);
    expect(store.listMembers().map((member) => member.email)).toEqual(["a@example.com", "c@example.com"]);
    expect(store.listInvites().find((candidate) => candidate.id === pending.id)?.role).toBe("admin");
    expect(await readStoredHosts(path)).toHaveLength(2);
  });

  it("leaves no host bound after signing out, and restores it on the next sign-in", async () => {
    const { store, path } = await createStore();
    const owner = { id: "account-a", email: "a@example.com", name: "A", avatarUrl: null };
    const identity = await store.configureWithAccount("Studio Mac", owner);

    await store.deactivate();
    expect(store.configured).toBe(false);
    expect(store.getIdentity()).toBeNull();

    const restarted = new TeamStore(path);
    await restarted.initialize();
    expect(restarted.configured).toBe(false);

    await restarted.activateAccount(owner);
    expect(restarted.getIdentity()?.serverId).toBe(identity.serverId);
  });

  it("stores one host when an account configures twice at once", async () => {
    const { store, path } = await createStore();
    const owner = { id: "account-a", email: "a@example.com", name: "A", avatarUrl: null };
    const logo = {
      mimeType: "image/png" as const,
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    };

    const results = await Promise.allSettled([
      store.configureWithAccount("Studio Mac", owner, logo),
      store.configureWithAccount("Loft Mini", owner, logo),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await readStoredHosts(path)).toHaveLength(1);
    const restarted = new TeamStore(path);
    await restarted.initialize();
    await restarted.activateAccount(owner);
    expect(restarted.getIdentity()?.serverId).toBe(store.getIdentity()?.serverId);
  });

  it("refuses a configuration that finishes after another account has signed in", async () => {
    const { store, path } = await createStore();
    const first = { id: "account-a", email: "a@example.com", name: "A", avatarUrl: null };
    const second = { id: "account-b", email: "b@example.com", name: "B", avatarUrl: null };
    await store.activateAccount(first);

    const pending = store.configureWithAccount("Studio Mac", first, {
      mimeType: "image/png",
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    });
    await store.activateAccount(second);

    await expect(pending).rejects.toThrow("signed-in account changed");
    expect(store.configured).toBe(false);
    expect(await readStoredHosts(path)).toHaveLength(0);
  });

  it("keeps a team file it cannot read instead of writing over it", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-team-"));
    roots.push(root);
    const path = join(root, "team.json");
    // A file a newer build wrote. Nothing here is backed up, so it has to survive.
    const original = `${JSON.stringify({ version: 3, hosts: [{ serverId: "from-the-future" }] })}\n`;
    await writeFile(path, original, "utf8");
    const store = new TeamStore(path);
    await store.initialize();
    const account = { id: "account-a", email: "a@example.com", name: "A", avatarUrl: null };

    await store.activateAccount(account);
    expect(store.configured).toBe(false);
    await expect(store.configureWithAccount("Studio Mac", account)).rejects.toThrow("could not be read");

    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("refuses a configuration whose write lands after another account has signed in", async () => {
    const { store, path } = await createStore();
    const first = { id: "account-a", email: "a@example.com", name: "A", avatarUrl: null };
    const second = { id: "account-b", email: "b@example.com", name: "B", avatarUrl: null };
    await store.activateAccount(second);
    const secondIdentity = await store.configureWithAccount("Studio Air", second);
    await store.activateAccount(first);

    const pending = store.configureWithAccount("Studio Mac", first);
    const settled = pending.catch(() => undefined);
    await store.activateAccount(second);
    await settled;

    // Answering with B's own host would have the caller apply A's configuration - its logo,
    // its remote registration - to the server B was already running.
    await expect(pending).rejects.toThrow("signed-in account changed");
    expect(store.getIdentity()).toEqual(secondIdentity);
    // A's host is A's own and stays stored: signing back in as A must return it.
    expect((await readStoredHosts(path)).map((host) => host.serverName)).toEqual(["Studio Air", "Studio Mac"]);
  });

  it("refuses an identity update whose write lands after another account has signed in", async () => {
    const { store, path } = await createStore();
    const first = { id: "account-a", email: "a@example.com", name: "A", avatarUrl: null };
    const second = { id: "account-b", email: "b@example.com", name: "B", avatarUrl: null };
    await store.activateAccount(second);
    const secondIdentity = await store.configureWithAccount("Studio Air", second);
    await store.activateAccount(first);
    await store.configureWithAccount("Studio Mac", first);

    const pending = store.updateIdentity({ serverName: "Renamed" });
    const settled = pending.catch(() => undefined);
    await store.activateAccount(second);
    await settled;

    // Answering with A's identity has the caller push A's host to the remote directory under
    // B's authentication and owner membership.
    await expect(pending).rejects.toThrow("no longer the active one");
    expect(store.getIdentity()).toEqual(secondIdentity);
    // The rename is A's own and stays: it is what A asked for and it is already on disk.
    expect((await readStoredHosts(path)).map((host) => host.serverName)).toEqual(["Studio Air", "Renamed"]);
  });

  it("leaves no host bound when recording the next account fails", async () => {
    const { store, path } = await createStore();
    const first = { id: "account-a", email: "a@example.com", name: "A", avatarUrl: null };
    const second = { id: "account-b", email: "b@example.com", name: "B", avatarUrl: null };
    await store.activateAccount(first);
    await store.configureWithAccount("Studio Mac", first);
    const root = path.slice(0, -"/team.json".length);
    const unavailableRoot = `${root}-unavailable`;

    await rename(root, unavailableRoot);
    await expect(store.activateAccount(second)).rejects.toThrow();
    await rename(unavailableRoot, root);

    // Signing in as B has already happened elsewhere, so answering for A's host is the
    // failure this store exists to prevent. Nothing is lost: the file still holds it.
    expect(store.configured).toBe(false);
    expect((await readStoredHosts(path)).map((host) => host.serverName)).toEqual(["Studio Mac"]);
    await store.activateAccount(first);
    expect(store.getIdentity()?.serverName).toBe("Studio Mac");
  });

  it("refuses an identity update that lands after another account has signed in", async () => {
    const { store, path } = await createStore();
    const first = { id: "account-a", email: "a@example.com", name: "A", avatarUrl: null };
    const second = { id: "account-b", email: "b@example.com", name: "B", avatarUrl: null };
    await store.activateAccount(first);
    await store.configureWithAccount("Studio Mac", first);
    await store.activateAccount(second);
    const secondIdentity = await store.configureWithAccount("Studio Air", second);
    await store.activateAccount(first);

    const pending = store.updateIdentity({
      serverName: "Renamed",
      logo: { mimeType: "image/png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
    });
    // The update rejects while the switch below is still settling, so keep it handled.
    const settled = pending.catch(() => undefined);
    await store.activateAccount(second);
    await settled;

    await expect(pending).rejects.toThrow("no longer the active one");
    expect(store.getIdentity()).toEqual(secondIdentity);
    const hosts = await readStoredHosts(path);
    expect(hosts.map((host) => host.serverName)).toEqual(["Studio Mac", "Studio Air"]);
    expect(hosts.every((host) => host.serverLogo === undefined)).toBe(true);
  });

  it("refuses a launch preference decided for a host that is no longer active", async () => {
    const { store } = await createStore();
    const first = { id: "account-a", email: "a@example.com", name: "A", avatarUrl: null };
    const second = { id: "account-b", email: "b@example.com", name: "B", avatarUrl: null };
    const firstIdentity = await store.configureWithAccount("Studio Mac", first);

    await store.activateAccount(second);
    await store.configureWithAccount("Loft Mini", second);

    await expect(store.setEnabledOnLaunch(firstIdentity.serverId, true)).rejects.toThrow("no longer the active one");
    expect(store.getIdentity()?.enabledOnLaunch).toBe(false);
    await store.activateAccount(first);
    expect(store.getIdentity()?.enabledOnLaunch).toBe(false);
  });

  it("refuses a second host beside an owner-less one that is not active", async () => {
    const { store, path } = await createStore();
    await store.configure("Studio Mac", "owner", "correct horse battery");
    const owner = { id: "account-a", email: "a@example.com", name: "A", avatarUrl: null };
    await store.deactivate();

    await expect(store.configureWithAccount("Loft Mini", owner)).rejects.toThrow("already configured");
    expect(await readStoredHosts(path)).toHaveLength(1);
    await store.activateAccount(owner);
    expect(store.getIdentity()?.serverName).toBe("Studio Mac");
  });

  it("refuses a remote directory loaded for a host that is no longer active", async () => {
    const { store } = await createStore();
    const first = { id: "account-a", email: "a@example.com", name: "A", avatarUrl: null };
    const second = { id: "account-b", email: "b@example.com", name: "B", avatarUrl: null };
    const firstIdentity = await store.configureWithAccount("Studio Mac", first);

    await store.activateAccount(second);
    await store.configureWithAccount("Loft Mini", second);
    const ownerMemberId = store.getOwnerMemberId();

    await expect(
      store.syncRemoteDirectory(firstIdentity.serverId, [
        {
          membershipId: "account-a-owner",
          email: "a@example.com",
          name: "A",
          avatarUrl: null,
          role: "owner",
          status: "active",
          createdAt: 1_900_000_000_000,
        },
      ]),
    ).rejects.toThrow("no longer the active one");
    expect(store.getOwnerMemberId()).toBe(ownerMemberId);
    expect(store.listMembers().map((member) => member.email)).toEqual(["b@example.com"]);
  });

  it("adopts a host configured before accounts existed and records its owner", async () => {
    const { store, path } = await createStore();
    const identity = await store.configure("Studio Mac", "owner", "correct horse battery");
    const owner = { id: "account-a", email: "a@example.com", name: "A", avatarUrl: null };

    await store.activateAccount(owner);
    expect(store.getIdentity()?.serverId).toBe(identity.serverId);
    expect(store.getOwnerAnalyticsIdentity()).toEqual({ id: "account-a", email: "a@example.com" });
    expect(() => store.assertOwnerAccount(owner)).not.toThrow();

    const restarted = new TeamStore(path);
    await restarted.initialize();
    await restarted.activateAccount(owner);
    expect(restarted.getIdentity()?.serverId).toBe(identity.serverId);
    expect(await readStoredHosts(path)).toHaveLength(1);
  });

  it("activates nothing for an account that has no host", async () => {
    const { store, path } = await createStore();
    await store.activateAccount({ id: "account-a", email: "a@example.com", name: "A", avatarUrl: null });

    expect(store.configured).toBe(false);
    expect(await readStoredHosts(path)).toHaveLength(0);
  });

  it("allows only the OpenBot email that created the host to own it", async () => {
    const { store } = await createStore();
    await store.configureWithAccount("Studio Mac", {
      id: "owner-account",
      email: "Owner@Example.com",
      name: "Owner",
      avatarUrl: null,
    });

    expect(() =>
      store.assertOwnerAccount({
        id: "owner-account",
        email: "owner@example.com",
        name: "Owner",
        avatarUrl: null,
      }),
    ).not.toThrow();
    expect(() =>
      store.assertOwnerAccount({
        id: "other-account",
        email: "other@example.com",
        name: null,
        avatarUrl: null,
      }),
    ).toThrow("email that created this host");
  });

  it("rejects a verified account that does not match an email invitation", async () => {
    const { store } = await createStore();
    await store.configureWithAccount("Studio Mac", {
      id: "owner-account",
      email: "owner@example.com",
      name: null,
      avatarUrl: null,
    });
    const invite = await store.createInvite("member", "alice@example.com");

    await expect(
      store.acceptInviteWithAccount(invite.token, {
        id: "bob-account",
        email: "bob@example.com",
        name: null,
        avatarUrl: null,
      }),
    ).rejects.toThrow("different email");
  });

  it("revokes a session on logout and persists members", async () => {
    const { store, path } = await createStore();
    await store.configure("Studio Mac", "owner", "correct horse battery");
    const login = await store.login("owner", "correct horse battery");
    await store.logout(login.sessionToken);
    expect(store.authenticate(login.sessionToken)).toBeNull();
    const restored = new TeamStore(path);
    await restored.initialize();
    expect(restored.listMembers()).toHaveLength(1);
  });

  it("manages member roles, disabled accounts, sessions, and invitations", async () => {
    const { store } = await createStore();
    await store.configure("Studio Mac", "owner", "correct horse battery");
    const invite = await store.createInvite("member");
    const joined = await store.acceptInvite(invite.token, "alice", "a secure team password");
    expect(store.listSessions()).toHaveLength(1);
    expect(store.listInvites()[0]?.usedAt).not.toBeNull();

    await store.updateMember(joined.member.id, { role: "admin" });
    expect(store.listMembers().find((member) => member.id === joined.member.id)?.role).toBe("admin");
    await store.updateMember(joined.member.id, { disabled: true });
    expect(store.authenticate(joined.sessionToken)).toBeNull();
    expect(store.listSessions()).toHaveLength(0);
    await store.removeMember(joined.member.id);
    expect(store.listMembers()).toHaveLength(1);
    await expect(store.removeMember(store.listMembers()[0]?.id ?? "")).rejects.toThrow(
      "owner account cannot be removed",
    );
    await store.revokeInvite(invite.id);
    expect(store.listInvites()).toHaveLength(0);
  });

  it("invalidates sessions after a password change", async () => {
    const { store } = await createStore();
    await store.configure("Studio Mac", "owner", "correct horse battery");
    const login = await store.login("owner", "correct horse battery");
    await store.changePassword(login.member.id, "correct horse battery", "a newer secure password");
    expect(store.authenticate(login.sessionToken)).toBeNull();
    await expect(store.login("owner", "correct horse battery")).rejects.toThrow("incorrect");
    await expect(store.login("owner", "a newer secure password")).resolves.toBeDefined();
  });
});

/** Only the stored fields these tests read - the store owns the full shape. */
interface StoredHostFields {
  serverId?: string;
  serverName?: string;
  enabledOnLaunch?: boolean;
  serverLogo?: { version?: string; mimeType?: string; bytes?: unknown };
  members?: Array<{ accountId?: string }>;
}

/** The file holds one host per account; every host field a test reads lives under `hosts`. */
async function readStoredHosts(path: string): Promise<StoredHostFields[]> {
  // Nothing worth recording writes no file at all, which stores no host either way.
  try {
    return JSON.parse(await readFile(path, "utf8")).hosts;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function readStoredHost(path: string, index = 0): Promise<StoredHostFields> {
  const host = (await readStoredHosts(path))[index];
  if (!host) throw new Error(`No stored host at index ${index}.`);
  return host;
}

async function createStore() {
  const root = await mkdtemp(join(tmpdir(), "openbot-team-"));
  roots.push(root);
  const path = join(root, "team.json");
  const store = new TeamStore(path);
  await store.initialize();
  return { store, path };
}
