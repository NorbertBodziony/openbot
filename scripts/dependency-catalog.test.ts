// @vitest-environment node

// The catalog in the root package.json is the single place a shared dependency's
// version is written; every workspace that wants one asks for "catalog:". Nothing
// in bun enforces that, so `bun add vitest` inside a workspace silently writes a
// literal back and the versions drift apart again - which is how three workspaces
// ended up on typescript@5.9.3 while the rest ran 7.0.2, and mobile on a different
// zod than the desktop app. This test is what keeps the catalog from decaying into
// a comment.
//
// The second describe covers the other fact about these manifests that nothing
// else enforces: which of them the remote API image has to carry.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DynamicRecord } from "@openbot/contracts/runtime-values";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");

const rootManifest = readManifest("package.json");
const workspaces = readWorkspaces(rootManifest);
const catalog = readCatalog(rootManifest);
const manifests = ["package.json", ...workspaces.map((workspace) => `${workspace}/package.json`)];

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

// A "catalog:" specifier is only meaningful to bun. Anything that reads the
// declared version string itself sees a value it cannot parse, so these keep
// their literal versions in every manifest that declares them, and the reason
// travels with the name.
const NOT_CATALOGUABLE: Readonly<Record<string, string>> = {
  "solid-js":
    "storybook-solidjs-vite resolves the Solid major from the declared version to choose its renderer entry, and fails the Storybook build with `Could not detect Solid version` when it cannot.",
};

describe("dependency catalog", () => {
  it("declares every catalogued dependency as catalog: in every workspace that uses it", () => {
    const literals: string[] = [];
    for (const manifest of manifests) {
      for (const [field, name, version] of readDependencies(manifest)) {
        if (name in catalog && version !== "catalog:") literals.push(`${manifest} ${field}.${name}: ${version}`);
      }
    }

    expect(literals).toEqual([]);
  });

  // A catalog is for versions more than one workspace shares. An entry nobody
  // asks for reads as centrally managed while managing nothing, and an entry only
  // one workspace asks for is indirection with no second party to keep in step.
  it("catalogs only versions that at least two workspaces share", () => {
    const users = new Map<string, string[]>(Object.keys(catalog).map((name) => [name, []]));
    for (const manifest of manifests) {
      for (const [, name] of readDependencies(manifest)) {
        const manifestsUsing = users.get(name);
        if (manifestsUsing && !manifestsUsing.includes(manifest)) manifestsUsing.push(manifest);
      }
    }

    const underused = [...users]
      .filter(([, manifestsUsing]) => manifestsUsing.length < 2)
      .map(
        ([name, manifestsUsing]) =>
          `${name}: used by ${manifestsUsing.length} (${manifestsUsing.join(", ") || "none"})`,
      );

    expect(underused).toEqual([]);
  });

  // The assertion above only sees dependencies the catalog already names, so on
  // its own it says nothing about the next shared dependency to arrive. Two
  // workspaces can both `bun add yaml` with literal versions and stay green,
  // which is the drift this catalog exists to stop. This is the other direction.
  it("catalogs every external dependency that two workspaces already share", () => {
    const users = new Map<string, Map<string, string>>();
    for (const manifest of manifests) {
      for (const [, name, version] of readDependencies(manifest)) {
        const sites = users.get(name) ?? new Map<string, string>();
        sites.set(manifest, version);
        users.set(name, sites);
      }
    }

    const uncatalogued = [...users]
      .filter(([name, sites]) => sites.size >= 2 && !(name in catalog) && !(name in NOT_CATALOGUABLE))
      // A workspace member is resolved by the workspace protocol, not by a version.
      .filter(([, sites]) => ![...sites.values()].every((version) => version.startsWith("workspace:")))
      .map(
        ([name, sites]) =>
          `${name}: ${[...sites].map(([manifest, version]) => `${version} in ${manifest}`).join(", ")}`,
      )
      .sort();

    expect(uncatalogued).toEqual([]);
  });

  // Catalogue one of these and the failure surfaces minutes later in a CI job
  // that does not mention the catalog at all. This is that failure, named.
  it("leaves out the dependencies whose declared version a build tool reads", () => {
    const wronglyCatalogued = Object.keys(NOT_CATALOGUABLE)
      .filter((name) => name in catalog)
      .map((name) => `${name}: ${NOT_CATALOGUABLE[name]}`);

    expect(wronglyCatalogued).toEqual([]);
  });

  it("pins the same version everywhere for a dependency the catalog cannot hold", () => {
    const conflicting: string[] = [];
    for (const name of Object.keys(NOT_CATALOGUABLE)) {
      const sites = new Map<string, string[]>();
      for (const manifest of manifests) {
        for (const [, dependency, version] of readDependencies(manifest)) {
          if (dependency === name) sites.set(version, [...(sites.get(version) ?? []), manifest]);
        }
      }
      if (sites.size > 1) {
        const spread = [...sites].map(([version, where]) => `${version} in ${where.join(", ")}`).sort();
        conflicting.push(`${name}: ${spread.join(" vs ")}`);
      }
    }

    expect(conflicting).toEqual([]);
  });
});

// The remote API image installs from a pruned checkout: the Dockerfile copies the
// root manifest and lockfile, then one manifest per workspace, and runs
// `bun install --frozen-lockfile --filter @openbot/remote-api`. Bun refuses that
// install unless every workspace the remaining ones depend on is on disk, so a new
// `workspace:*` entry in the root manifest breaks the production image while every
// job in CI stays green - none of them builds this image. That is not hypothetical:
// the root package gained `@openbot/logging` and `@openbot/team-client` without the
// matching COPY lines, and `bun run remote:up` had been failing on
// `the root package depends on workspace "@openbot/logging" (packages/logging),
// which is listed in bun.lock but not on disk`.
describe("remote API Dockerfile", () => {
  it("copies a manifest for every workspace the pruned install needs", () => {
    const directoryOf = new Map(
      workspaces.map((directory) => [readManifest(`${directory}/package.json`).name, directory]),
    );
    const required = new Set<string>();
    const pending: unknown[] = [...workspaceDependencies("package.json"), "@openbot/remote-api"];
    while (pending.length > 0) {
      const name = pending.pop();
      if (!isString(name) || required.has(name)) continue;
      required.add(name);
      const directory = directoryOf.get(name);
      if (isString(directory)) pending.push(...workspaceDependencies(`${directory}/package.json`));
    }

    // Extra COPY lines are harmless - bun prunes whatever nothing depends on - so
    // this asserts the set that must be present, never the exact list.
    const dockerfile = readFileSync(join(repositoryRoot, "remote/api/Dockerfile"), "utf8");
    const copied = [...dockerfile.matchAll(/^COPY (\S+\/package\.json) /gm)].map((match) => match[1]);
    const missing = [...required]
      .map((name) => directoryOf.get(name))
      .filter(isString)
      .filter((directory) => !copied.includes(`${directory}/package.json`))
      .sort();

    expect(missing).toEqual([]);
  });
});

function workspaceDependencies(manifest: string): string[] {
  return readDependencies(manifest)
    .filter(([, , version]) => version.startsWith("workspace:"))
    .map(([, name]) => name);
}

function readManifest(path: string): DynamicRecord {
  const parsed = JSON.parse(readFileSync(join(repositoryRoot, path), "utf8"));
  if (!isDynamicRecord(parsed)) throw new Error(`${path} is not an object.`);
  return parsed;
}

// Expands the workspace globs the root manifest declares, so a workspace added
// later is covered without editing this test.
function readWorkspaces(manifest: DynamicRecord): readonly string[] {
  const workspaces = manifest.workspaces;
  if (!isDynamicRecord(workspaces)) throw new Error("Expected the object form of workspaces, with a catalog.");
  const patterns = workspaces.packages;
  if (!Array.isArray(patterns)) throw new Error("Expected workspaces.packages to be an array of globs.");

  const directories: string[] = [];
  for (const pattern of patterns) {
    if (!isString(pattern)) throw new Error("Expected every workspace glob to be a string.");
    if (!pattern.endsWith("/*")) {
      directories.push(pattern);
      continue;
    }
    const parent = pattern.slice(0, -2);
    for (const entry of readdirSync(join(repositoryRoot, parent), { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(repositoryRoot, parent, entry.name, "package.json"))) {
        directories.push(`${parent}/${entry.name}`);
      }
    }
  }
  return directories.sort();
}

function readCatalog(manifest: DynamicRecord): Record<string, string> {
  const workspaces = manifest.workspaces;
  if (!isDynamicRecord(workspaces) || !isDynamicRecord(workspaces.catalog)) {
    throw new Error("Expected a workspaces.catalog block in the root package.json.");
  }
  const catalogued: Record<string, string> = {};
  for (const [name, version] of Object.entries(workspaces.catalog)) {
    if (!isString(version)) throw new Error(`Expected a version string for the catalog entry ${name}.`);
    catalogued[name] = version;
  }
  return catalogued;
}

function readDependencies(path: string): readonly (readonly [string, string, string])[] {
  const manifest = readManifest(path);
  const declared: (readonly [string, string, string])[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    const block = manifest[field];
    if (!isDynamicRecord(block)) continue;
    for (const [name, version] of Object.entries(block)) {
      if (!isString(version)) throw new Error(`Expected a version string for ${field}.${name} in ${path}.`);
      declared.push([field, name, version]);
    }
  }
  return declared;
}
