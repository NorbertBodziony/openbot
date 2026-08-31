import { lstat, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareSite } from "./hosted-site-service";

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

  it("rejects symlinks and paths outside the allowed roots", async () => {
    const root = await fixture();
    const outside = await fixture();
    await writeFile(join(root, "index.html"), "ok");
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(join(outside, "secret.txt"), join(root, "secret.txt"));

    await expect(prepareSite(root)).rejects.toThrow("Symlinks");
    await expect(prepareSite(outside, [root])).rejects.toThrow("workspace");
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

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openbot-site-test-"));
  roots.push(root);
  return root;
}
