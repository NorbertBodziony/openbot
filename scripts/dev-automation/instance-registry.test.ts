// The registry exists because several worktrees run dev at once. What it has
// to get right is which of them a command drives, and that a dead instance
// never keeps offering its port to the next one.
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDevInstanceRecord, type DevelopmentServiceSpec } from "../dev-services";
import {
  assertOwnerOnlyDirectory,
  type DevInstanceRecord,
  dropReusedDebuggingPorts,
  isRecordedProcess,
  parseDevInstanceRecord,
  readDevInstanceRecords,
  removeDevInstanceRecord,
  selectDevInstance,
  writeDevInstanceRecord,
} from "./instance-registry";

function record(overrides: Partial<DevInstanceRecord> = {}): DevInstanceRecord {
  return {
    service: "app",
    instanceId: "default",
    profile: "OpenBot Dev",
    projectRoot: "/worktrees/one",
    rendererPort: 5_173,
    remoteDebuggingPort: 9_333,
    pid: 4_242,
    startedAt: 1_000,
    ...overrides,
  };
}

describe("selectDevInstance", () => {
  const here = record();
  const sibling = record({
    instanceId: "5174",
    profile: "OpenBot Dev 5174",
    projectRoot: "/worktrees/two",
    rendererPort: 5_174,
    remoteDebuggingPort: 9_335,
    pid: 4_243,
  });

  it("drives the instance of the worktree the command runs in", () => {
    expect(selectDevInstance([sibling, here], { projectRoot: "/worktrees/one" })).toEqual({
      kind: "selected",
      record: here,
      match: "worktree",
    });
  });

  it("marks another worktree's lone instance foreign so mutations refuse it", () => {
    expect(selectDevInstance([sibling], { projectRoot: "/worktrees/one" })).toEqual({
      kind: "selected",
      record: sibling,
      match: "foreign",
    });
  });

  it("refuses to guess between two worktrees", () => {
    expect(selectDevInstance([here, sibling], { projectRoot: "/worktrees/three" })).toEqual({
      kind: "ambiguous",
      candidates: [here, sibling],
    });
  });

  it("honours an explicitly named instance from any worktree", () => {
    expect(selectDevInstance([here, sibling], { projectRoot: "/worktrees/one", instanceId: "5174" })).toEqual({
      kind: "selected",
      record: sibling,
      match: "instance-id",
    });
  });

  it("reports an unknown instance id instead of falling back to a live one", () => {
    expect(selectDevInstance([here], { projectRoot: "/worktrees/one", instanceId: "9999" })).toEqual({
      kind: "unknown",
      candidates: [here],
    });
  });

  it("keeps the test client out of the app's candidates", () => {
    const testClient = record({ service: "test-client", instanceId: "test", remoteDebuggingPort: 9_334 });
    expect(selectDevInstance([testClient], { projectRoot: "/worktrees/one" })).toEqual({
      kind: "unknown",
      candidates: [],
    });
    expect(selectDevInstance([testClient], { projectRoot: "/worktrees/one", service: "test-client" })).toEqual({
      kind: "selected",
      record: testClient,
      match: "worktree",
    });
  });
});

describe("parseDevInstanceRecord", () => {
  it("accepts a record a dev instance wrote", () => {
    expect(parseDevInstanceRecord(record())).toEqual(record());
  });

  it("rejects a record whose ports could not have come from dev", () => {
    expect(parseDevInstanceRecord(record({ remoteDebuggingPort: 80 }))).toBeNull();
    expect(parseDevInstanceRecord(record({ rendererPort: 70_000 }))).toBeNull();
    expect(parseDevInstanceRecord(record({ pid: 0 }))).toBeNull();
    expect(parseDevInstanceRecord({ ...record(), service: "api" })).toBeNull();
    expect(parseDevInstanceRecord({ ...record(), projectRoot: "" })).toBeNull();
    expect(parseDevInstanceRecord("app")).toBeNull();
  });
});

describe("readDevInstanceRecords", () => {
  let directory = "";

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "openbot-dev-instances-test-"));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("round-trips a published instance and drops it again on shutdown", () => {
    writeDevInstanceRecord(record(), directory);
    expect(readDevInstanceRecords(directory, () => true)).toEqual([record()]);
    // The staging file the atomic write goes through must not survive it: a
    // leftover would be read on the next start as a second instance.
    expect(readdirSync(directory)).toEqual(["app-4242.json"]);
    removeDevInstanceRecord(record(), directory);
    expect(readDevInstanceRecords(directory, () => true)).toEqual([]);
  });

  it("forgets an instance whose process is gone instead of offering its port", () => {
    const alive = record({ pid: 1_111 });
    const dead = record({ pid: 2_222, remoteDebuggingPort: 9_335, rendererPort: 5_174, instanceId: "5174" });
    writeDevInstanceRecord(alive, directory);
    writeDevInstanceRecord(dead, directory);
    expect(readDevInstanceRecords(directory, (candidate) => candidate.pid === 1_111)).toEqual([alive]);
    expect(readdirSync(directory)).toEqual(["app-1111.json"]);
  });

  it("survives a half-written or hand-edited file", () => {
    writeFileSync(join(directory, "app-9.json"), "{ not json", "utf8");
    writeFileSync(join(directory, "app-10.json"), JSON.stringify({ service: "app" }), "utf8");
    expect(readDevInstanceRecords(directory, () => true)).toEqual([]);
  });

  it("keeps only the newest claim on a debugging port, so a mutation cannot be aimed at a stale one", () => {
    // Both processes answer, but one port has one owner: the older record is
    // an instance that died and left its pid to be recycled, and driving it
    // would type into whichever profile now holds 9333.
    const stale = record({ pid: 1_111, startedAt: 1_000 });
    const current = record({ pid: 2_222, startedAt: 2_000, profile: "OpenBot Dev 19333", instanceId: "19333" });
    writeDevInstanceRecord(stale, directory);
    writeDevInstanceRecord(current, directory);
    expect(readDevInstanceRecords(directory, () => true)).toEqual([current]);
  });
});

describe("isRecordedProcess", () => {
  it("rejects a pid that was recycled after the record was published", () => {
    // `startedAt` is taken right after spawn, so a process that started a
    // minute later is a different one wearing the same pid.
    expect(isRecordedProcess(record({ startedAt: 100_000 }), 160_000)).toBe(false);
  });

  it("accepts the process the record was written for, and one whose start cannot be read", () => {
    expect(isRecordedProcess(record({ startedAt: 100_000 }), 99_000)).toBe(true);
    // `ps` rounds down to the second and the clock can drift between the two
    // readings, so a start marginally later than the record still matches.
    expect(isRecordedProcess(record({ startedAt: 100_000 }), 101_000)).toBe(true);
    expect(isRecordedProcess(record({ startedAt: 100_000 }), null)).toBe(true);
  });
});

describe("dropReusedDebuggingPorts", () => {
  it("leaves instances on ports of their own alone", () => {
    const here = record({ pid: 1_111 });
    const sibling = record({ pid: 2_222, remoteDebuggingPort: 9_335, projectRoot: "/worktrees/two" });
    expect(dropReusedDebuggingPorts([here, sibling])).toEqual([here, sibling]);
  });
});

describe("createDevInstanceRecord", () => {
  it("publishes the ports the instance actually won and the profile they belong to", () => {
    const spec: DevelopmentServiceSpec = {
      name: "app",
      executable: "electron-vite",
      args: [],
      cwd: "/worktrees/two",
      env: {
        OPENBOT_DEV_RENDERER_PORT: "5174",
        OPENBOT_DEV_REMOTE_DEBUGGING_PORT: "9335",
        OPENBOT_DEV_INSTANCE_ID: "5174",
      },
    };
    expect(createDevInstanceRecord(spec, 77, 1_700)).toEqual({
      service: "app",
      instanceId: "5174",
      profile: "OpenBot Dev 5174",
      projectRoot: "/worktrees/two",
      rendererPort: 5_174,
      remoteDebuggingPort: 9_335,
      pid: 77,
      startedAt: 1_700,
    });
  });

  it("publishes nothing for a service automation cannot drive", () => {
    expect(
      createDevInstanceRecord({ name: "api", executable: "bun", args: [], cwd: "/worktrees/two", env: {} }, 77, 1_700),
    ).toBeNull();
  });
});

describe("writeDevInstanceRecord permissions", () => {
  it("keeps the registry directory and its records readable only by their owner", () => {
    const directory = mkdtempSync(join(tmpdir(), "openbot-registry-mode-"));
    writeDevInstanceRecord(record(), directory);
    // The path is predictable and lives in a shared /tmp, so the mode is the
    // only thing keeping another local account from reading which worktree a
    // developer has open.
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(join(directory, "app-4242.json")).mode & 0o777).toBe(0o600);
    rmSync(directory, { recursive: true, force: true });
  });
});

describe("assertOwnerOnlyDirectory", () => {
  // A registry another account controls lets it forge a record naming this
  // worktree, a live pid and a CDP port of its choosing - and a mutation
  // command would treat that port as the named instance it may drive. Both
  // branches decide against publishing, which is why they are checked here
  // rather than through the filesystem: a second uid cannot be arranged in a
  // unit test, and a directory this user owns is repaired by `chmod` instead.
  it("refuses a directory owned by another account", () => {
    expect(() =>
      assertOwnerOnlyDirectory("/tmp/registry", { uid: 999, mode: 0o40700, symbolicLink: false }, 501),
    ).toThrow("not owned by this user");
  });

  it("refuses a directory other accounts can reach and a symlinked one", () => {
    expect(() =>
      assertOwnerOnlyDirectory("/tmp/registry", { uid: 501, mode: 0o40777, symbolicLink: false }, 501),
    ).toThrow("accessible to other accounts");
    expect(() =>
      assertOwnerOnlyDirectory("/tmp/registry", { uid: 501, mode: 0o40700, symbolicLink: true }, 501),
    ).toThrow("not owned by this user");
  });

  it("guards the reader too, not only the writer", () => {
    const directory = mkdtempSync(join(tmpdir(), "openbot-registry-read-"));
    writeDevInstanceRecord(record(), directory);
    chmodSync(directory, 0o777);
    // A reader that never publishes would otherwise trust a planted record.
    expect(() => readDevInstanceRecords(directory, () => true)).toThrow("accessible to other accounts");
    rmSync(directory, { recursive: true, force: true });
  });

  it("accepts the owner-only directory dev publishes into", () => {
    expect(() =>
      assertOwnerOnlyDirectory("/tmp/registry", { uid: 501, mode: 0o40700, symbolicLink: false }, 501),
    ).not.toThrow();
  });
});
