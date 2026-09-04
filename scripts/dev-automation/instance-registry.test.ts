// The registry exists because several worktrees run dev at once. What it has
// to get right is which of them a command drives, and that a dead instance
// never keeps offering its port to the next one.
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDevInstanceRecord, type DevelopmentServiceSpec } from "../dev-services";
import {
  type DevInstanceRecord,
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
    expect(readDevInstanceRecords(directory, (pid) => pid === 1_111)).toEqual([alive]);
    expect(readdirSync(directory)).toEqual(["app-1111.json"]);
  });

  it("survives a half-written or hand-edited file", () => {
    writeFileSync(join(directory, "app-9.json"), "{ not json", "utf8");
    writeFileSync(join(directory, "app-10.json"), JSON.stringify({ service: "app" }), "utf8");
    expect(readDevInstanceRecords(directory, () => true)).toEqual([]);
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
