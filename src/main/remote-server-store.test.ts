// @vitest-environment node

// `servers.json` against a real disk. `remote-server-stored-shape.test.ts` covers what the reader
// makes of a value; this covers what the store does with the answer, which is the half that can lose
// the file. The reader returning null is only safe if nothing writes afterwards, and only a test that
// owns a path can say so.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_SERVER_ID } from "@openbot/contracts/ipc";
import { afterEach, describe, expect, it } from "vitest";
import { RemoteServerStore } from "./remote-server-store";
import type { StoredRemoteServer } from "./remote-server-stored-shape";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function storePath(contents: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "openbot-remote-store-"));
  directories.push(directory);
  const path = join(directory, "servers.json");
  await writeFile(path, JSON.stringify(contents), "utf8");
  return path;
}

function newStore(path: string): RemoteServerStore {
  return new RemoteServerStore({
    path,
    cipher: { encrypt: (value) => Buffer.from(value), decrypt: (value) => value.toString() },
  });
}

function storedServer(id: string, overrides: Partial<StoredRemoteServer> = {}): StoredRemoteServer {
  return {
    id,
    name: `Server ${id}`,
    apiUrl: `https://${id}.trycloudflare.com/`,
    fingerprint: `fingerprint-${id}`,
    username: "ada",
    encryptedToken: "dG9rZW4=",
    remoteDesktopAvailable: false,
    role: "member",
    ...overrides,
  };
}

describe("remote server store", () => {
  it("leaves a file written by a newer build on disk instead of replacing it", async () => {
    const written = { version: 4, activeServerId: "alpha", servers: [storedServer("alpha")], hiddenHostIds: [] };
    const path = await storePath(written);
    const store = newStore(path);

    await expect(store.load()).rejects.toThrow(/format this version can read/);

    // The user downgraded, and the point is that reinstalling the newer build still finds their
    // servers. A store that loaded empty here would write that emptiness over them.
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(written);
  });

  it("writes back the servers it kept and the entry it could not read", async () => {
    // Intact identity and token, one field this build does not accept. Dropping it would be the same
    // data loss as dropping the file, one write later -- and the build that understands
    // `remoteDesktopAvailable: "false"` would never get the chance to repair it.
    const broken = { ...storedServer("broken"), remoteDesktopAvailable: "false" };
    const path = await storePath({
      version: 1,
      activeServerId: "beta",
      servers: [storedServer("alpha"), broken, storedServer("beta")],
      hiddenHostIds: ["host-1"],
    });
    const store = newStore(path);
    await store.load();

    expect(store.servers.map((server) => server.id)).toEqual(["alpha", "beta"]);
    store.setActiveServerId(LOCAL_SERVER_ID);
    await store.persist();

    // In its own slot, not appended: `servers` order is the sidebar order the user arranged, and an
    // unrelated write must not reshuffle a list this build cannot even display.
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      version: 3,
      activeServerId: LOCAL_SERVER_ID,
      servers: [{ id: "alpha" }, broken, { id: "beta" }],
      hiddenHostIds: ["host-1"],
    });
  });

  it("keeps a preserved entry when reconciliation recreates its id, and drops it when the user rejoins", async () => {
    // A WebRTC host whose entry this build cannot read is absent from `servers`, so the next host
    // directory sync offers it as new and `replaceServers` mints a fresh entry with the same id. The
    // preserved one holds the pinned key and fingerprint; nothing about a directory advertisement
    // earns the right to delete them.
    const broken = { ...storedServer("beta"), role: "overlord" };
    const path = await storePath({
      version: 3,
      activeServerId: LOCAL_SERVER_ID,
      servers: [broken],
      hiddenHostIds: [],
    });
    const store = newStore(path);
    await store.load();

    await store.replaceServers([storedServer("beta", { name: "Advertised" })]);
    expect(JSON.parse(await readFile(path, "utf8")).servers).toEqual([
      expect.objectContaining({ id: "beta", name: "Advertised" }),
      broken,
    ]);

    // Joining verifies the host's identity, so it does supersede the old entry. The WebRTC join
    // path gets its entry from `replaceServers` rather than `adopt`, and says so separately.
    await store.retireUnreadable("beta");
    expect(JSON.parse(await readFile(path, "utf8")).servers).toEqual([
      expect.objectContaining({ id: "beta", name: "Advertised" }),
    ]);
  });

  it("retires a preserved entry when the user rejoins over it", async () => {
    const broken = { ...storedServer("beta"), role: "overlord" };
    const path = await storePath({ version: 3, activeServerId: LOCAL_SERVER_ID, servers: [broken], hiddenHostIds: [] });
    const store = newStore(path);
    await store.load();

    await store.adopt(storedServer("beta", { name: "Rejoined" }));

    expect(JSON.parse(await readFile(path, "utf8")).servers).toEqual([
      expect.objectContaining({ id: "beta", name: "Rejoined" }),
    ]);
  });

  it("keeps a preserved entry in front of the server it preceded, even after that list changes", async () => {
    const broken = { ...storedServer("middle"), role: "overlord" };
    const path = await storePath({
      version: 3,
      activeServerId: LOCAL_SERVER_ID,
      servers: [storedServer("alpha"), broken, storedServer("beta")],
      hiddenHostIds: [],
    });
    const store = newStore(path);
    await store.load();

    // The slot is the entry that followed it, not a number: removing the server in front of it must
    // not push it past the one behind it, which is what a saved index would have done.
    await store.remove("alpha");

    expect(JSON.parse(await readFile(path, "utf8")).servers).toEqual([broken, expect.objectContaining({ id: "beta" })]);
  });

  it("keeps naming the active server it could not read until the user picks another", async () => {
    const broken = { ...storedServer("beta"), role: "overlord" };
    const path = await storePath({
      version: 3,
      activeServerId: "beta",
      servers: [storedServer("alpha"), broken],
      hiddenHostIds: [],
    });
    const store = newStore(path);
    await store.load();

    // This build runs on the local server, because it cannot use the entry the user was on. An
    // unrelated write must not turn that into the user's stored choice.
    expect(store.activeServerId).toBe(LOCAL_SERVER_ID);
    await store.persist();
    expect(JSON.parse(await readFile(path, "utf8")).activeServerId).toBe("beta");

    store.setActiveServerId("alpha");
    await store.persist();
    expect(JSON.parse(await readFile(path, "utf8")).activeServerId).toBe("alpha");
  });

  it("puts back both halves of a selection whose write failed", async () => {
    const broken = { ...storedServer("beta"), role: "overlord" };
    const path = await storePath({
      version: 3,
      activeServerId: "beta",
      servers: [storedServer("alpha"), broken],
      hiddenHostIds: [],
    });
    const store = newStore(path);
    await store.load();

    // What `RemoteServerManager.select` does when its write throws. Restoring the id alone would
    // leave the preserved selection cleared, and the next unrelated write would make the local
    // fallback the user's stored choice -- the failure this rollback exists to prevent.
    const selection = store.selection;
    store.setActiveServerId("alpha");
    store.restoreSelection(selection);
    await store.persist();

    expect(store.activeServerId).toBe(LOCAL_SERVER_ID);
    expect(JSON.parse(await readFile(path, "utf8")).activeServerId).toBe("beta");
  });
});
