// @vitest-environment node

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseAddressUpdateUrl, verifyAddressUpdate } from "./remote-server-manager";
import { fingerprint, TeamStore } from "./team-store";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("TeamStore", () => {
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

  it("uses an invitation once and preserves its role", async () => {
    const { store } = await createStore();
    await store.configure("Studio Mac", "owner", "correct horse battery");
    const invite = await store.createInvite("member");
    const joined = await store.acceptInvite(invite.token, "alice", "a secure team password");
    expect(joined.member.role).toBe("member");
    await expect(
      store.acceptInvite(invite.token, "bob", "another secure password"),
    ).rejects.toThrow("invalid or expired");
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
    expect(store.listMembers().find((member) => member.id === joined.member.id)?.role).toBe(
      "admin",
    );
    await store.updateMember(joined.member.id, { disabled: true });
    expect(store.authenticate(joined.sessionToken)).toBeNull();
    expect(store.listSessions()).toHaveLength(0);
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

  it("signs an address update that is bound to the pinned fingerprint", async () => {
    const { store } = await createStore();
    const identity = await store.configure("Studio Mac", "owner", "correct horse battery");
    const proof = store.createAddressUpdateProof(
      "https://new-api.trycloudflare.com/",
      "new-vnc.trycloudflare.com",
    );
    const url = new URL("openbot://update");
    url.searchParams.set("api", proof.apiUrl);
    url.searchParams.set("server", proof.serverId);
    url.searchParams.set("vnc", proof.vncHostname ?? "");
    url.searchParams.set("key", Buffer.from(proof.publicKey).toString("base64url"));
    url.searchParams.set("signature", proof.signature);
    const parsed = parseAddressUpdateUrl(url.toString());
    expect(fingerprint(verifyAddressUpdate(parsed, identity.fingerprint))).toBe(
      identity.fingerprint,
    );
    expect(() =>
      verifyAddressUpdate(
        { ...parsed, apiUrl: "https://other.trycloudflare.com/" },
        identity.fingerprint,
      ),
    ).toThrow("signature");
  });
});

async function createStore() {
  const root = await mkdtemp(join(tmpdir(), "openbot-team-"));
  roots.push(root);
  const path = join(root, "team.json");
  const store = new TeamStore(path);
  await store.initialize();
  return { store, path };
}
