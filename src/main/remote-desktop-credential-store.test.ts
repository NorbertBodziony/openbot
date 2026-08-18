// @vitest-environment node

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RemoteDesktopCredentialStore } from "./remote-desktop-credential-store";

const roots: string[] = [];
const cipher = {
  encrypt: (value: string) => Buffer.from(`sealed:${value}`, "utf8"),
  decrypt: (value: Buffer) => value.toString("utf8").replace(/^sealed:/u, ""),
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("RemoteDesktopCredentialStore", () => {
  it("persists only an encrypted VNC password with private file permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-desktop-credential-"));
    roots.push(root);
    const path = join(root, "credential.json");
    const store = new RemoteDesktopCredentialStore(path, cipher);
    await store.initialize();
    expect(store.configured).toBe(false);

    await store.setPassword("deskpass");
    expect(store.getPassword()).toBe("deskpass");
    expect(await readFile(path, "utf8")).not.toContain("deskpass");
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    const restored = new RemoteDesktopCredentialStore(path, cipher);
    await restored.initialize();
    expect(restored.getPassword()).toBe("deskpass");
  });

  it("rejects passwords that VNC cannot use", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-desktop-credential-"));
    roots.push(root);
    const store = new RemoteDesktopCredentialStore(join(root, "credential.json"), cipher);
    await expect(store.setPassword("ninechars")).rejects.toThrow("1 to 8");
    await expect(store.setPassword("bad\npass")).rejects.toThrow("printable");
  });
});
