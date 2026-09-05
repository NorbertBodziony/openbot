// @vitest-environment node

// Each renderer window is an HTML file naming its entry module as a path string,
// and electron.vite.config.ts names the HTML files. Nothing type-checks either
// hop: tsc never reads the HTML, vitest never loads it, and the renderer imports
// the entry from nowhere, so a moved entry module leaves an .html pointing at a
// file that no longer exists and every check stays green until `electron-vite
// build` fails on a macOS runner minutes later. That is exactly how moving
// browser-pip.tsx into features/browser broke the build while typecheck, lint,
// check:ui and 674 renderer tests all passed.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");
const rendererRoot = resolve(repositoryRoot, "src/renderer");

function read(path: string): string {
  return readFileSync(resolve(repositoryRoot, path), "utf8");
}

// The HTML files the build is told to compile, in the order the config lists them.
function configuredPages(): string[] {
  const config = read("electron.vite.config.ts");
  return [...config.matchAll(/resolve\("(src\/renderer\/[\w-]+\.html)"\)/gu)].map((match) => match[1]);
}

// A page's entry modules, as written: `<script type="module" src="/src/...">`,
// where the leading slash is the renderer root rather than the filesystem root.
function entriesOf(page: string): string[] {
  return [...read(page).matchAll(/<script[^>]+src="(\/[^"]+)"/gu)].map((match) => match[1]);
}

describe("renderer entry points", () => {
  const pages = configuredPages();

  it("compiles every window the config names", () => {
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.filter((page) => !existsSync(resolve(repositoryRoot, page)))).toEqual([]);
  });

  it("points every window at an entry module that exists", () => {
    const missing = pages.flatMap((page) =>
      entriesOf(page)
        .filter((entry) => !existsSync(resolve(rendererRoot, entry.slice(1))))
        .map((entry) => `${page} -> ${entry}`),
    );
    expect(missing).toEqual([]);
  });

  it("gives every window an entry module", () => {
    expect(pages.filter((page) => entriesOf(page).length === 0)).toEqual([]);
  });
});
