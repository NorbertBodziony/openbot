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

    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      version: 3,
      activeServerId: LOCAL_SERVER_ID,
      servers: [{ id: "alpha" }, { id: "beta" }, broken],
      hiddenHostIds: ["host-1"],
    });
  });

  it("drops a preserved entry once a real server takes its id", async () => {
    const broken = { ...storedServer("beta"), role: "overlord" };
    const path = await storePath({
      version: 3,
      activeServerId: LOCAL_SERVER_ID,
      servers: [broken],
      hiddenHostIds: [],
    });
    const store = newStore(path);
    await store.load();

    await store.adopt(storedServer("beta", { name: "Rejoined" }));

    // Joining the server replaces the broken entry. Keeping both would leave the file holding two
    // servers with one id, and every later read picking whichever it happened to see first.
    const written = JSON.parse(await readFile(path, "utf8"));
    expect(written.servers).toEqual([expect.objectContaining({ id: "beta", name: "Rejoined" })]);
  });
});
