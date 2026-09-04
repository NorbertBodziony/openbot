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
import { dirname, extname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");

const SHARED_TOKENS = "packages/brand/src/tokens.css";
const NATIVE_TOKENS = "packages/brand/src/tokens-native.css";

// How each palette is spelled at an import site. Everything else here asserts what
// the shared file contains; this is what ties a surface to it.
const IMPORT_OF: Readonly<Record<string, string>> = {
  [SHARED_TOKENS]: '@import "@openbot/brand/tokens.css";',
  [NATIVE_TOKENS]: '@import "@openbot/brand/tokens-native.css";',
};

// Where a surface is allowed to look for a token: the shared palette, plus files
// that legitimately bind one in a narrower scope. Anything a surface references
// and none of these declares is a token that resolves to nothing at runtime.
const SURFACES = [
  {
    name: "desktop renderer",
    // styles.css imports every partial under styles/, and Storybook renders the
    // same components against the same palette.
    sources: ["src/renderer/src", "src/renderer/stories", ".storybook"],
    entry: "src/renderer/src/styles.css",
    imports: [SHARED_TOKENS],
    scopedDeclarations: ["src/renderer/src/styles/settings-modal.css"],
  },
  {
    name: "public web",
    sources: ["apps/auth-api/src"],
    entry: "apps/auth-api/src/styles.css",
    imports: [SHARED_TOKENS],
    // The /app-preview route imports the renderer's stylesheet wholesale.
    scopedDeclarations: ["src/renderer/src/styles/settings-modal.css"],
  },
  {
    name: "mobile",
    sources: ["apps/mobile/src", "apps/mobile/global.css"],
    entry: "apps/mobile/global.css",
    imports: [SHARED_TOKENS, NATIVE_TOKENS],
    scopedDeclarations: [NATIVE_TOKENS],
  },
] as const;

// A surface may declare a root --openbot-* of its own only with the reason written
// down. The escape hatch is keyed by name so the reason travels with it, and the
// next person can tell a deliberate override from a copy someone forgot to delete.
// Scoping the rule to names already in the shared palette would not do: a
// surface-only name is a second declaration site just the same, and the surface
// that owns it is the one place nobody else looks.
const SURFACE_OVERRIDES: Readonly<Record<string, string>> = {};

const sharedTokens = readRootTokens(SHARED_TOKENS);

describe("design tokens", () => {
  it("declares every token in the shared palette and nowhere else", () => {
    const redeclared = new Set<string>();
    for (const surface of SURFACES) {
      for (const file of stylesheetsOf(surface)) {
        for (const name of readRootTokens(file).keys()) {
          if (!(name in SURFACE_OVERRIDES)) redeclared.add(`${file}: ${name}`);
        }
      }
    }

    expect([...redeclared].sort()).toEqual([]);
  });

  // The failure this replaces is silent: a var() naming a token the surface never
  // declares paints nothing at all, which reads as a styling bug three files away
  // from its cause.
  it("resolves every token a surface references to a declaration that surface can see", () => {
    const unresolved: string[] = [];
    for (const surface of SURFACES) {
      const declared = new Set(sharedTokens.keys());
      for (const file of [surface.entry, ...surface.scopedDeclarations]) {
        for (const name of readDeclaredTokens(file)) declared.add(name);
      }

      const scanned = new Set<string>(stylesheetsOf(surface));
      for (const source of surface.sources) {
        for (const path of filesUnder(source)) if (extname(path) !== ".css") scanned.add(path);
      }

      for (const [name, where] of readReferencedTokens([...scanned])) {
        if (!declared.has(name)) unresolved.push(`${surface.name} ${where}: ${name}`);
      }
    }

    expect(unresolved.sort()).toEqual([]);
  });

  // Everything above assumes the surface can see the shared palette, and an
  // @import is the entirety of what makes that true. Delete one and every other
  // assertion here stays green while that surface renders with no palette at all -
  // the exact silent half-change this file exists to stop.
  it("imports the shared palette into every surface", () => {
    const missing: string[] = [];
    for (const surface of SURFACES) {
      const entry = read(surface.entry);
      for (const palette of surface.imports) {
        if (!entry.includes(IMPORT_OF[palette])) missing.push(`${surface.entry}: ${IMPORT_OF[palette]}`);
      }
    }

    expect(missing).toEqual([]);
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

// Every stylesheet a surface actually loads: the entry, everything it @imports
// transitively, every stylesheet under its own directories, and any CSS a
// component pulls in from TypeScript. Listing files by directory alone was not
// enough - packages/brand/src/logo.css lives outside all three surfaces yet is
// loaded by two of them and reads eight palette tokens, so a name dropped from
// the palette would have broken the logo with every assertion here still green.
// The two palette files themselves are excluded: declaring tokens is their job.
function stylesheetsOf(surface: (typeof SURFACES)[number]): readonly string[] {
  const loaded = new Set<string>();
  follow(surface.entry, loaded);
  for (const source of surface.sources) {
    for (const path of filesUnder(source)) {
      if (extname(path) === ".css") follow(path, loaded);
      else for (const imported of stylesheetImports(path)) follow(imported, loaded);
    }
  }

  loaded.delete(SHARED_TOKENS);
  loaded.delete(NATIVE_TOKENS);
  return [...loaded];
}

function follow(path: string, loaded: Set<string>): void {
  if (loaded.has(path)) return;
  loaded.add(path);
  for (const imported of stylesheetImports(path)) follow(imported, loaded);
}

// The repository-local stylesheets a file pulls in, by @import in CSS or by a
// side-effect import in TypeScript. A bare specifier we do not publish - the
// Tailwind, uniwind, HeroUI and font packages - is somebody else's stylesheet.
function stylesheetImports(path: string): readonly string[] {
  const imports: string[] = [];
  for (const match of read(path).matchAll(/import\s+"([^"]+)"/gu)) {
    const specifier = match[1];
    if (specifier.startsWith(".")) imports.push(join(dirname(path), specifier));
    else {
      const packaged = /^@openbot\/brand\/(.+\.css)$/u.exec(specifier);
      if (packaged) imports.push(`packages/brand/src/${packaged[1]}`);
    }
  }
  return imports;
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
function readReferencedTokens(paths: readonly string[]): readonly (readonly [string, string])[] {
  const references: (readonly [string, string])[] = [];
  for (const path of paths) {
    for (const match of read(path).matchAll(/(?:var\(|useCSSVariable\(")\s*(--openbot-[a-z0-9-]+)/gu)) {
      references.push([match[1], path]);
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
