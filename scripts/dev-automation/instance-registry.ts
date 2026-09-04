// Several worktrees on one machine each run their own `bun run dev`, and only
// the first one gets the default ports: `dev-services` walks upwards when 9333
// or 5173 is busy, so the second instance answers on a port nobody wrote down.
// CDP itself carries no profile identity, so this registry is where a dev
// instance says which worktree, profile and renderer port belong to its
// debugging port. `dev:automation` reads it to drive the app of the worktree it
// was started from instead of whichever instance won the race for 9333.

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

// Written through a sibling and renamed into place. A plain write truncates
// first, and a reader that hits that window sees an unparseable file and
// deletes it as corrupt - which would leave a dev instance that just started
// undiscoverable until it restarts. `rename` within one directory is atomic,
// so a reader sees either the old record or the whole new one.
export function writeDevInstanceRecord(record: DevInstanceRecord, directory = devInstanceRegistryDirectory()): void {
  // Owner-only, because the path is predictable and shared: on a multi-account
  // Linux box the default 0755/0644 would let any local user read which
  // worktree and profile a developer has open. `chmod` after `mkdir` covers a
  // directory that already existed with wider modes; it can only fail when the
  // directory belongs to someone else, and then the write below fails anyway.
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    chmodSync(directory, 0o700);
  } catch {
    // Not ours to tighten - verified below, which is what fails closed.
  }
  const stats = lstatSync(directory);
  assertOwnerOnlyDirectory(directory, {
    uid: stats.uid,
    mode: stats.mode,
    symbolicLink: stats.isSymbolicLink(),
  });
  const target = recordPath(directory, record);
  const staging = `${target}.${process.pid}.tmp`;
  // Unlink first, then create exclusively: `wx` refuses to follow a
  // pre-created symlink, so a leftover or planted staging path cannot redirect
  // this write outside the registry. Unlinking a symlink removes the link, not
  // its target.
  rmSync(staging, { force: true });
  const handle = openSync(staging, "wx", 0o600);
  try {
    writeFileSync(handle, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  } finally {
    closeSync(handle);
  }
  renameSync(staging, target);
}

// Publishing into a directory somebody else controls is worse than not
// publishing at all: they could replace a record with a forged one naming this
// worktree, a live pid and a CDP port of their choosing, and a mutation command
// would treat that port as the named instance it is allowed to drive. So this
// fails closed rather than trusting that `chmod` worked.
export interface DirectoryOwnership {
  uid: number;
  mode: number;
  symbolicLink: boolean;
}

export function assertOwnerOnlyDirectory(
  directory: string,
  stats: DirectoryOwnership,
  owner = process.getuid?.(),
): void {
  if (stats.symbolicLink || (owner !== undefined && stats.uid !== owner)) {
    throw new Error(
      `${directory} is not owned by this user, so dev instances will not be published there. ` +
        "Remove it and start `bun run dev` again.",
    );
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new Error(
      `${directory} is accessible to other accounts (mode ${(stats.mode & 0o777).toString(8)}). ` +
        "Remove it and start `bun run dev` again: a registry another account can write lets it choose " +
        "which app an automation command drives.",
    );
  }
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

// `startedAt` is `Date.now()` taken right after `spawn`, so the process behind
// an honest record always started at or before it. `ps` reports whole seconds,
// which can only round downwards, and the grace covers a clock the developer
// nudged between the two readings.
const PROCESS_START_GRACE_MS = 2_000;

// Signal 0 proves only that *something* holds that pid. A dev instance killed
// with SIGKILL leaves its record behind, pids get recycled, and an unrelated
// process inheriting 4242 would keep that record - and its
// `remoteDebuggingPort` - looking like this worktree's live app, which is the
// one match `click` and `type` accept. Comparing when the process actually
// started separates them: a recycled pid always started after the record was
// written.
export function isRecordedProcess(record: DevInstanceRecord, processStartedAt: number | null): boolean {
  // Unverifiable, so this cannot be the fail-closed check on its own: `ps` is
  // absent on Windows and can be denied. `dropReusedDebuggingPorts` below is
  // what still refuses a stale claim when the start time is unknown.
  if (processStartedAt === null) return true;
  return processStartedAt <= record.startedAt + PROCESS_START_GRACE_MS;
}

// Wall-clock start of a live process, or null when it cannot be read. `lstart`
// is a full local timestamp on both macOS and Linux; `ps` on Windows is not
// this program at all, so it is not asked.
function readProcessStartedAt(pid: number): number | null {
  if (process.platform === "win32") return null;
  try {
    const reported = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const parsed = Date.parse(reported);
    return Number.isNaN(parsed) ? null : parsed;
  } catch {
    return null;
  }
}

function isDevInstanceLive(record: DevInstanceRecord): boolean {
  if (!isProcessAlive(record.pid)) return false;
  return isRecordedProcess(record, readProcessStartedAt(record.pid));
}

// One debugging port can be bound by one process, so two live records claiming
// the same one means the older claim no longer holds it - its instance died
// and left the record behind while its pid was recycled, or the file was
// planted. CDP carries no profile identity, so nothing at connect time could
// tell the two apart; the older claim is dropped instead of being offered as a
// named instance a mutation may drive. The file stays: the instance that owns
// it republishes on its next start.
export function dropReusedDebuggingPorts(records: DevInstanceRecord[]): DevInstanceRecord[] {
  const newestByPort = new Map<number, DevInstanceRecord>();
  for (const record of records) {
    const held = newestByPort.get(record.remoteDebuggingPort);
    if (!held || held.startedAt < record.startedAt) newestByPort.set(record.remoteDebuggingPort, record);
  }
  return records.filter((record) => newestByPort.get(record.remoteDebuggingPort) === record);
}

// A dev instance killed with SIGKILL never removes its own record, so reading
// prunes: a record whose process is gone is deleted rather than reported, which
// keeps a stale port from being offered after another instance reuses it.
export function readDevInstanceRecords(
  directory = devInstanceRegistryDirectory(),
  isAlive: (record: DevInstanceRecord) => boolean = isDevInstanceLive,
): DevInstanceRecord[] {
  if (!existsSync(directory)) return [];
  // The same gate as the writer, for the same reason and it has to be here
  // too: a directory another account can write lets it plant a record naming
  // this worktree, a live pid and a CDP endpoint of its choosing, which
  // `selectDevInstance` would then classify as the local worktree instance a
  // mutation is allowed to drive. Validating only on publish leaves a reader
  // that never published wide open.
  const directoryStats = lstatSync(directory);
  assertOwnerOnlyDirectory(directory, {
    uid: directoryStats.uid,
    mode: directoryStats.mode,
    symbolicLink: directoryStats.isSymbolicLink(),
  });
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
    if (record && isAlive(record)) {
      records.push(record);
      continue;
    }
    rmSync(path, { force: true });
  }
  return dropReusedDebuggingPorts(records).sort((left, right) => left.remoteDebuggingPort - right.remoteDebuggingPort);
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
