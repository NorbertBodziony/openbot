import { lstat, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type HostedSiteAuthClient, HostedSiteDesktopService, prepareSite } from "./hosted-site-service";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("hosted site preparation", () => {
  it("publishes vanilla files without a build step", async () => {
    const root = await fixture();
    await writeFile(join(root, "index.html"), "<h1>Hello</h1>");
    await writeFile(join(root, "style.css"), "body { color: white; }");

    const site = await prepareSite(root, [root]);

    expect(site.framework).toBe("vanilla");
    expect(site.files.map((file) => file.path)).toEqual(["index.html", "style.css"]);
  });

  it("publishes an existing Astro dist without running project scripts", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        scripts: { build: "node build.mjs" },
        devDependencies: { astro: "5.0.0" },
      }),
    );
    await writeFile(join(root, "build.mjs"), 'await Bun.write("script-was-run", "unsafe");');
    await mkdir(join(root, "src"));
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "dist", "index.html"), "<h1>Astro</h1>");
    await writeFile(join(root, "astro.config.mjs"), 'export default { output: "static" };');

    const site = await prepareSite(root);

    expect(site.framework).toBe("astro");
    expect(site.files.map((file) => file.path)).toEqual(["index.html"]);
    await expect(lstat(join(root, "script-was-run"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects Astro SSR and server adapters", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ scripts: { build: "node build.mjs" }, dependencies: { astro: "5.0.0" } }),
    );
    await writeFile(join(root, "astro.config.mjs"), 'export default { output: "server", adapter: cloudflare() };');

    await expect(prepareSite(root)).rejects.toThrow("static output");
  });

  it("requires Astro to have an existing dist directory", async () => {
    const root = await fixture();
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { astro: "5.0.0" } }));

    await expect(prepareSite(root)).rejects.toThrow("existing dist");
  });

  it("rejects an Astro dist symlink that escapes the project", async () => {
    const root = await fixture();
    const outside = await fixture();
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { astro: "5.0.0" } }));
    await writeFile(join(outside, "index.html"), "not from this project");
    await symlink(outside, join(root, "dist"));

    await expect(prepareSite(root)).rejects.toThrow("real directory");
  });

  it("rejects symlinks and paths outside the allowed roots", async () => {
    const root = await fixture();
    const outside = await fixture();
    await writeFile(join(root, "index.html"), "ok");
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(join(outside, "secret.txt"), join(root, "secret.txt"));

    await expect(prepareSite(root)).rejects.toThrow("Symlinks");
    await expect(prepareSite(outside, [root])).rejects.toThrow("workspace");
  });

  it("rejects a selected source directory that is a symlink", async () => {
    const workspace = await fixture();
    const target = join(workspace, "site");
    const alias = join(workspace, "site-alias");
    await mkdir(target);
    await writeFile(join(target, "index.html"), "ok");
    await symlink(target, alias);

    await expect(prepareSite(alias, [workspace])).rejects.toThrow("Symlinks");
  });

  it("enforces the 20 file limit", async () => {
    const root = await fixture();
    await writeFile(join(root, "index.html"), "ok");
    for (let index = 0; index < 20; index += 1) await writeFile(join(root, `file-${index}.txt`), "x");
    await expect(prepareSite(root)).rejects.toThrow("20 files");
  });

  it.each(["service-account.json", "private-key.txt", "server.js"])("rejects unsafe file %s", async (name) => {
    const root = await fixture();
    await writeFile(join(root, "index.html"), "ok");
    await writeFile(join(root, name), "not safe");

    await expect(prepareSite(root)).rejects.toThrow("private keys");
  });
});

describe("hosted site upload recovery", () => {
  it("reuses the publication key after the upload-session response is lost", async () => {
    const root = await fixture();
    await writeFile(join(root, "index.html"), "<h1>Recovery</h1>");
    const publicationKeys: string[] = [];
    let publicationAttempts = 0;
    const auth = authClient(async (path, init) => {
      if (path === "/v1/sites/") {
        publicationKeys.push(requiredHeader(init, "Idempotency-Key"));
        publicationAttempts += 1;
        if (publicationAttempts <= 2) throw new TypeError("The response was lost.");
        return uploadSession();
      }
      if (path.includes("/file?")) return { uploaded: true };
      if (path.endsWith("/activate")) return hostedSite();
      throw new Error(`Unexpected request: ${path}`);
    });
    const service = new HostedSiteDesktopService(auth);
    const input = { sourcePath: root, title: "Recovery page", description: "Recover a publication response." };

    await expect(service.publish(input)).rejects.toThrow("response was lost");
    await expect(service.publish(input)).resolves.toMatchObject({ id: "site-1" });

    expect(publicationAttempts).toBe(3);
    expect(new Set(publicationKeys).size).toBe(1);
  });

  it("resumes the same upload after the activation response is lost", async () => {
    const root = await fixture();
    await writeFile(join(root, "index.html"), "<h1>Activation recovery</h1>");
    const activationKeys: string[] = [];
    let publicationAttempts = 0;
    let fileAttempts = 0;
    let activationAttempts = 0;
    const auth = authClient(async (path, init) => {
      if (path === "/v1/sites/") {
        publicationAttempts += 1;
        return uploadSession();
      }
      if (path.includes("/file?")) {
        fileAttempts += 1;
        return { uploaded: true };
      }
      if (path.endsWith("/activate")) {
        activationKeys.push(requiredHeader(init, "Idempotency-Key"));
        activationAttempts += 1;
        if (activationAttempts <= 2) throw new TypeError("The activation response was lost.");
        return hostedSite();
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const service = new HostedSiteDesktopService(auth);
    const input = { sourcePath: root, title: "Recovery page", description: "Recover an activation response." };

    await expect(service.publish(input)).rejects.toThrow("activation response was lost");
    await expect(service.publish(input)).resolves.toMatchObject({ id: "site-1" });

    expect(publicationAttempts).toBe(1);
    expect(fileAttempts).toBe(1);
    expect(activationAttempts).toBe(3);
    expect(new Set(activationKeys).size).toBe(1);
  });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openbot-site-test-"));
  roots.push(root);
  return root;
}

function authClient(handler: (path: string, init: RequestInit) => Promise<unknown>): HostedSiteAuthClient {
  return {
    async requestAuthorized<T>(path: string, init: RequestInit, decoder: (value: unknown) => T): Promise<T> {
      return decoder(await handler(path, init));
    },
  };
}

function requiredHeader(init: RequestInit, name: string): string {
  const value = new Headers(init.headers).get(name);
  if (!value) throw new Error(`${name} is missing.`);
  return value;
}

function uploadSession(): { uploadId: string; expiresAt: string } {
  return { uploadId: "upload-1", expiresAt: new Date(Date.now() + 15 * 60 * 1_000).toISOString() };
}

function hostedSite() {
  return {
    id: "site-1",
    hostname: "recovery-page-for-upload-tests-23456789ab.openbot.site",
    url: "https://recovery-page-for-upload-tests-23456789ab.openbot.site",
    title: "Recovery page",
    description: "Recover a publication response.",
    framework: "vanilla",
    status: "active",
    fileCount: 1,
    size: 20,
    expiresAt: "2026-09-30T12:00:00.000Z",
    updatedAt: "2026-09-01T12:00:00.000Z",
  };
}
