// Several worktrees on one machine each run their own `bun run dev`, and only
// the first one gets the default ports: `dev-services` walks upwards when 9333
// or 5173 is busy, so the second instance answers on a port nobody wrote down.
// CDP itself carries no profile identity, so this registry is where a dev
// instance says which worktree, profile and renderer port belong to its
// debugging port. `dev:automation` reads it to drive the app of the worktree it
// was started from instead of whichever instance won the race for 9333.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isDynamicRecord, isNumber, isOneOf, isString } from "@openbot/contracts/runtime-values";

export type DevInstanceService = "app" | "test-client";

const DEV_INSTANCE_SERVICES: readonly DevInstanceService[] = ["app", "test-client"];

export interface DevInstanceRecord {
  service: DevInstanceService;
  // The profile suffix `developmentUserDataName` appends, or "default" for the
  // unsuffixed profile. This is what a developer types into `--instance=`.
  instanceId: string;
  profile: string;
  projectRoot: string;
  rendererPort: number;
  remoteDebuggingPort: number;
  pid: number;
  startedAt: number;
}

// A per-user temporary directory, not the app data root: a record describes a
// process, so losing every record on reboot is correct, and it keeps automation
// discovery away from the SQLite profiles.
export function devInstanceRegistryDirectory(): string {
  return join(tmpdir(), "openbot-dev-instances");
}

function recordPath(directory: string, record: Pick<DevInstanceRecord, "pid" | "service">): string {
  return join(directory, `${record.service}-${record.pid}.json`);
}

export function parseDevInstanceRecord(raw: unknown): DevInstanceRecord | null {
  if (!isDynamicRecord(raw)) return null;
  const { service, instanceId, profile, projectRoot, rendererPort, remoteDebuggingPort, pid, startedAt } = raw;
  if (!isOneOf(DEV_INSTANCE_SERVICES, service)) return null;
  if (!isString(instanceId) || instanceId === "") return null;
  if (!isString(profile) || profile === "") return null;
  if (!isString(projectRoot) || projectRoot === "") return null;
  if (!isPort(rendererPort) || !isPort(remoteDebuggingPort)) return null;
  if (!isNumber(pid) || !Number.isInteger(pid) || pid <= 0) return null;
  if (!isNumber(startedAt) || !Number.isFinite(startedAt)) return null;
  return { service, instanceId, profile, projectRoot, rendererPort, remoteDebuggingPort, pid, startedAt };
}

function isPort(value: unknown): value is number {
  return isNumber(value) && Number.isInteger(value) && value >= 1_024 && value <= 65_535;
}

export function writeDevInstanceRecord(record: DevInstanceRecord, directory = devInstanceRegistryDirectory()): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(recordPath(directory, record), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

export function removeDevInstanceRecord(
  record: Pick<DevInstanceRecord, "pid" | "service">,
  directory = devInstanceRegistryDirectory(),
): void {
  rmSync(recordPath(directory, record), { force: true });
}

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 checks for the process without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// A dev instance killed with SIGKILL never removes its own record, so reading
// prunes: a record whose process is gone is deleted rather than reported, which
// keeps a stale port from being offered after another instance reuses it.
export function readDevInstanceRecords(
  directory = devInstanceRegistryDirectory(),
  isAlive: (pid: number) => boolean = isProcessAlive,
): DevInstanceRecord[] {
  if (!existsSync(directory)) return [];
  const records: DevInstanceRecord[] = [];
  for (const entry of readdirSync(directory)) {
    if (!entry.endsWith(".json")) continue;
    const path = join(directory, entry);
    let record: DevInstanceRecord | null = null;
    try {
      record = parseDevInstanceRecord(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      record = null;
    }
    if (record && isAlive(record.pid)) {
      records.push(record);
      continue;
    }
    rmSync(path, { force: true });
  }
  return records.sort((left, right) => left.remoteDebuggingPort - right.remoteDebuggingPort);
}

export interface DevInstanceQuery {
  projectRoot: string;
  instanceId?: string | null;
  service?: DevInstanceService;
}

// "worktree" is the only match strong enough to drive: the record was written
// by the dev instance of the very checkout the command runs in. "instance-id"
// is the developer naming one by hand. "foreign" is the single instance of some
// other worktree - fine to read, never enough to click.
export type DevInstanceMatch = "instance-id" | "worktree" | "foreign";

export type DevInstanceSelection =
  | { kind: "selected"; record: DevInstanceRecord; match: DevInstanceMatch }
  | { kind: "ambiguous"; candidates: DevInstanceRecord[] }
  | { kind: "unknown"; candidates: DevInstanceRecord[] };

export function selectDevInstance(records: DevInstanceRecord[], query: DevInstanceQuery): DevInstanceSelection {
  const service = query.service ?? "app";
  const candidates = records.filter((record) => record.service === service);
  const requested = query.instanceId?.trim();
  if (requested !== undefined && requested !== "") {
    const named = candidates.filter((record) => record.instanceId === requested);
    const [record, ...extra] = named;
    if (!record) return { kind: "unknown", candidates };
    if (extra.length > 0) return { kind: "ambiguous", candidates: named };
    return { kind: "selected", record, match: "instance-id" };
  }
  const root = resolve(query.projectRoot);
  const local = candidates.filter((record) => resolve(record.projectRoot) === root);
  const [localRecord, ...extraLocal] = local;
  if (localRecord && extraLocal.length === 0) return { kind: "selected", record: localRecord, match: "worktree" };
  if (localRecord) return { kind: "ambiguous", candidates: local };
  const [soleRecord, ...extraForeign] = candidates;
  if (soleRecord && extraForeign.length === 0) return { kind: "selected", record: soleRecord, match: "foreign" };
  if (soleRecord) return { kind: "ambiguous", candidates };
  return { kind: "unknown", candidates };
}

// Diagnostics name the worktree and the profile, never a URL or a title: which
// checkout an instance belongs to is what a developer needs, and it cannot
// carry a token the way a page URL can.
export function describeDevInstance(record: DevInstanceRecord): string {
  return `${record.service} :${record.remoteDebuggingPort} instance=${record.instanceId} profile="${record.profile}" root=${record.projectRoot}`;
}
