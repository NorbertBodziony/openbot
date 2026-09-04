// @vitest-environment node

// Every --openbot-* token is written once, in packages/brand/src/tokens.css, and
// the desktop renderer, the public web app and the mobile app all import it.
// Nothing in CSS enforces that. Before this file existed the same names lived in
// three palettes that no single commit had ever touched together: the web one was
// a frozen snapshot of a desktop palette that had grown by two hundred tokens
// since, mobile disagreed with both on the sidebar colour, and a var() naming a
// token that existed nowhere rendered as nothing rather than failing. This test is
// what keeps the one source of truth from decaying back into three.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");

const SHARED_TOKENS = "packages/brand/src/tokens.css";
const NATIVE_TOKENS = "packages/brand/src/tokens-native.css";

// Where a surface is allowed to look for a token: the shared palette, plus files
// that legitimately bind one in a narrower scope. Anything a surface references
// and none of these declares is a token that resolves to nothing at runtime.
const SURFACES = [
  {
    name: "desktop renderer",
    // styles.css imports every partial under styles/, and Storybook renders the
    // same components against the same palette.
    sources: ["src/renderer/src", "src/renderer/stories", ".storybook"],
    rootDeclarations: ["src/renderer/src/styles.css"],
    scopedDeclarations: ["src/renderer/src/styles/settings-modal.css"],
  },
  {
    name: "public web",
    sources: ["apps/auth-api/src"],
    rootDeclarations: ["apps/auth-api/src/styles.css"],
    // The /app-preview route imports the renderer's stylesheet wholesale.
    scopedDeclarations: ["src/renderer/src/styles/settings-modal.css"],
  },
  {
    name: "mobile",
    sources: ["apps/mobile/src", "apps/mobile/global.css"],
    rootDeclarations: ["apps/mobile/global.css"],
    scopedDeclarations: [NATIVE_TOKENS],
  },
] as const;

// A surface may redeclare a shared token only with the reason written down. The
// point of the escape hatch is that the reason travels with the name, so the next
// person can tell a deliberate override from a copy someone forgot to delete.
const SURFACE_OVERRIDES: Readonly<Record<string, string>> = {};

const sharedTokens = readRootTokens(SHARED_TOKENS);

describe("design tokens", () => {
  it("declares every token in the shared palette and nowhere else", () => {
    const redeclared: string[] = [];
    for (const surface of SURFACES) {
      for (const file of surface.rootDeclarations) {
        for (const name of readRootTokens(file).keys()) {
          if (sharedTokens.has(name) && !(name in SURFACE_OVERRIDES)) redeclared.push(`${file}: ${name}`);
        }
      }
    }

    expect(redeclared).toEqual([]);
  });

  // The failure this replaces is silent: a var() naming a token the surface never
  // declares paints nothing at all, which reads as a styling bug three files away
  // from its cause.
  it("resolves every token a surface references to a declaration that surface can see", () => {
    const unresolved: string[] = [];
    for (const surface of SURFACES) {
      const declared = new Set(sharedTokens.keys());
      for (const file of [...surface.rootDeclarations, ...surface.scopedDeclarations]) {
        for (const name of readDeclaredTokens(file)) declared.add(name);
      }

      for (const [name, where] of readReferencedTokens(surface.sources)) {
        if (!declared.has(name)) unresolved.push(`${surface.name} ${where}: ${name}`);
      }
    }

    expect(unresolved.sort()).toEqual([]);
  });

  // uniwind hard-codes its theme list to ['light', 'dark'] and reads a theme's
  // variables only from @variant at-rules, so mobile cannot inherit its dark
  // values from the shared :root - it has to restate them. It notices a name
  // present in one theme and missing from the other, but only logs it in red and
  // builds anyway. These two assertions are that check, made to fail.
  it("gives the mobile light and dark themes the same token names", () => {
    const light = readVariantTokens(NATIVE_TOKENS, "light");
    const dark = readVariantTokens(NATIVE_TOKENS, "dark");

    expect([...light.keys()].sort()).toEqual([...dark.keys()].sort());
  });

  it("keeps the mobile dark theme on the shared palette's values", () => {
    const drifted: string[] = [];
    for (const [name, value] of readVariantTokens(NATIVE_TOKENS, "dark")) {
      const base = sharedTokens.get(name);
      if (base !== value) drifted.push(`${name}: dark has ${value}, ${SHARED_TOKENS} has ${base ?? "no value"}`);
    }

    expect(drifted.sort()).toEqual([]);
  });
});

// The palette itself: declarations whose innermost enclosing block is :root. Any
// at-rule around it is transparent, because mobile wraps its :root in @layer
// theme - tracking brace depth instead would make this blind to that whole file.
// A component rebinding a token under its own selector, and a theme variant
// nested inside :root, are both correctly excluded.
function readRootTokens(path: string): Map<string, string> {
  const tokens = new Map<string, string>();
  const blocks: string[] = [];
  let prelude = "";

  for (const line of read(path).split("\n")) {
    for (const part of splitBlocks(line)) {
      if (part === "{") {
        blocks.push(prelude.trim());
        prelude = "";
      } else if (part === "}") {
        blocks.pop();
        prelude = "";
      } else if (blocks.at(-1) === ":root") {
        const declaration = /^\s*(--openbot-[a-z0-9-]+):\s*(.+);\s*$/u.exec(part);
        if (declaration) tokens.set(declaration[1], declaration[2]);
        prelude = part;
      } else {
        prelude = part;
      }
    }
  }

  return tokens;
}

// The text of a line, cut at every brace, with the braces kept as their own parts.
function splitBlocks(line: string): readonly string[] {
  return line.split(/([{}])/u).filter((part) => part !== "");
}

function readVariantTokens(path: string, theme: string): Map<string, string> {
  const source = read(path);
  const start = source.indexOf(`@variant ${theme} {`);
  if (start === -1) throw new Error(`${path} declares no @variant ${theme} block.`);
  const end = source.indexOf("\n  }", start);
  if (end === -1) throw new Error(`The @variant ${theme} block in ${path} is not closed.`);

  const tokens = new Map<string, string>();
  for (const line of source.slice(start, end).split("\n")) {
    const declaration = /^\s*(--openbot-[a-z0-9-]+):\s*(.+);\s*$/u.exec(line);
    if (declaration) tokens.set(declaration[1], declaration[2]);
  }
  return tokens;
}

function readDeclaredTokens(path: string): readonly string[] {
  return [...read(path).matchAll(/^\s*(--openbot-[a-z0-9-]+):/gmu)].map((match) => match[1]);
}

// var(--openbot-x) in CSS and JSX, plus uniwind's useCSSVariable("--openbot-x"),
// which is how mobile reads a token outside a class name.
function readReferencedTokens(sources: readonly string[]): readonly (readonly [string, string])[] {
  const references: (readonly [string, string])[] = [];
  for (const source of sources) {
    for (const path of filesUnder(source)) {
      if (path === SHARED_TOKENS) continue;
      for (const match of read(path).matchAll(/(?:var\(|useCSSVariable\(")\s*(--openbot-[a-z0-9-]+)/gu)) {
        references.push([match[1], path]);
      }
    }
  }
  return references;
}

const SCANNED = new Set([".css", ".ts", ".tsx"]);

function filesUnder(source: string): readonly string[] {
  if (!statSync(join(repositoryRoot, source)).isDirectory()) return [source];

  const paths: string[] = [];
  for (const entry of readdirSync(join(repositoryRoot, source), { withFileTypes: true })) {
    const path = `${source}/${entry.name}`;
    if (entry.isDirectory()) paths.push(...filesUnder(path));
    else if (SCANNED.has(extname(entry.name))) paths.push(path);
  }
  return paths;
}

function read(path: string): string {
  return readFileSync(join(repositoryRoot, path), "utf8");
}
