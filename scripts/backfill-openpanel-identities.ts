import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { normalizeEmailAddress } from "@openbot/contracts/validation";

const DEFAULT_OPENPANEL_API_URL = "https://analytics.openbot.run/api";
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 250;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export interface BackfillAuthUser {
  id: string;
  email: string;
}

export interface BackfillOpenPanelProfile {
  profileId: string;
  email: string | null;
}

export interface BackfillIdentity {
  profileId: string;
  email: string;
}

export interface BackfillOptions {
  authUsersPath: string;
  openPanelProfilesPath: string;
  apply: boolean;
  apiUrl?: string;
  clientId?: string;
  clientSecret?: string;
  requestTimeoutMs?: number;
  fetcher?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface BackfillSummary {
  authUsers: number;
  openPanelProfiles: number;
  matchedProfiles: number;
  updates: number;
  applied: number;
}

export async function runBackfill(options: BackfillOptions): Promise<BackfillSummary> {
  const [authUsers, profiles] = await Promise.all([
    readRecords(options.authUsersPath, "auth users"),
    readRecords(options.openPanelProfilesPath, "OpenPanel profiles"),
  ]);
  const updates = buildBackfillUpdates(authUsers, profiles);
  const authIds = new Set(authUsers.map((user) => requiredIdentifier(parseAuthUser(user).id, "auth user id")));
  let applied = 0;
  if (options.apply) {
    applied = await applyBackfill(updates, options);
  }
  return {
    authUsers: authUsers.length,
    openPanelProfiles: profiles.length,
    matchedProfiles: profiles.filter((profile) =>
      authIds.has(requiredIdentifier(parseOpenPanelProfile(profile).profileId, "OpenPanel profile id")),
    ).length,
    updates: updates.length,
    applied,
  };
}

export function buildBackfillUpdates(authUsers: readonly unknown[], profiles: readonly unknown[]): BackfillIdentity[] {
  const usersById = new Map<string, string>();
  for (const user of authUsers) {
    const parsed = parseAuthUser(user);
    const id = requiredIdentifier(parsed.id, "auth user id");
    const email = requiredEmail(parsed.email, "auth user email");
    if (usersById.has(id)) throw new Error("Duplicate auth user id in the input.");
    usersById.set(id, email);
  }

  const profileIds = new Set<string>();
  const updates: BackfillIdentity[] = [];
  for (const profile of profiles) {
    const parsed = parseOpenPanelProfile(profile);
    const profileId = requiredIdentifier(parsed.profileId, "OpenPanel profile id");
    if (profileIds.has(profileId)) throw new Error("Duplicate OpenPanel profile id in the input.");
    profileIds.add(profileId);
    const email = usersById.get(profileId);
    if (!email) continue;
    const existingEmail = parsed.email?.trim() ? normalizeEmailAddress(parsed.email) : null;
    if (existingEmail === email) continue;
    updates.push({ profileId, email });
  }
  return updates.sort((left, right) => left.profileId.localeCompare(right.profileId));
}

export async function applyBackfill(
  updates: readonly BackfillIdentity[],
  options: Pick<BackfillOptions, "apiUrl" | "clientId" | "clientSecret" | "requestTimeoutMs" | "fetcher" | "sleep">,
) {
  const clientId = requiredSecret(options.clientId, "OPENPANEL_CLIENT_ID");
  const clientSecret = requiredSecret(options.clientSecret, "OPENPANEL_CLIENT_SECRET");
  const endpoint = trackEndpoint(options.apiUrl ?? DEFAULT_OPENPANEL_API_URL);
  const fetcher = options.fetcher ?? fetch;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));

  let applied = 0;
  for (const identity of updates) {
    await identifyProfile(
      endpoint,
      identity,
      clientId,
      clientSecret,
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      fetcher,
      sleep,
    );
    applied += 1;
  }
  return applied;
}

async function identifyProfile(
  endpoint: string,
  identity: BackfillIdentity,
  clientId: string,
  clientSecret: string,
  requestTimeoutMs: number,
  fetcher: typeof fetch,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error("OpenPanel backfill request timeout must be positive.");
  }
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    let response: Response;
    try {
      response = await fetcher(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "openpanel-client-id": clientId,
          "openpanel-client-secret": clientSecret,
          "openpanel-sdk-name": "openbot-backfill",
        },
        body: JSON.stringify({ type: "identify", payload: identity }),
        signal: controller.signal,
      });
    } catch {
      if (attempt === MAX_RETRIES) throw new Error("OpenPanel backfill request failed after retries.");
      await sleep(INITIAL_RETRY_DELAY_MS * 2 ** attempt);
      continue;
    } finally {
      clearTimeout(timeout);
    }
    if (response.status >= 200 && response.status < 300) return;
    if ((response.status !== 429 && (response.status < 500 || response.status >= 600)) || attempt === MAX_RETRIES) {
      throw new Error(`OpenPanel backfill failed with HTTP ${response.status}.`);
    }
    await sleep(INITIAL_RETRY_DELAY_MS * 2 ** attempt);
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const summary = await runBackfill(options);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (!options.apply && summary.updates > 0) {
    process.stdout.write("Dry run only. Re-run with --apply to update the listed profile count.\n");
  }
}

function parseOptions(args: string[]): BackfillOptions {
  let authUsersPath = "";
  let openPanelProfilesPath = "";
  let apply = false;
  let apiUrl: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--apply") {
      apply = true;
      continue;
    }
    if (argument === "--auth-users") {
      authUsersPath = nextArgument(args, ++index, "--auth-users");
      continue;
    }
    if (argument === "--openpanel-profiles") {
      openPanelProfilesPath = nextArgument(args, ++index, "--openpanel-profiles");
      continue;
    }
    if (argument === "--api-url") {
      apiUrl = nextArgument(args, ++index, "--api-url");
      continue;
    }
    if (argument === "--help") {
      process.stdout.write(
        "Usage: bun scripts/backfill-openpanel-identities.ts --auth-users FILE --openpanel-profiles FILE [--apply]\n",
      );
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (!authUsersPath || !openPanelProfilesPath) {
    throw new Error("Both --auth-users and --openpanel-profiles are required.");
  }
  return {
    authUsersPath,
    openPanelProfilesPath,
    apply,
    apiUrl: apiUrl ?? process.env.OPENPANEL_API_URL ?? DEFAULT_OPENPANEL_API_URL,
    clientId: process.env.OPENPANEL_CLIENT_ID,
    clientSecret: process.env.OPENPANEL_CLIENT_SECRET,
  };
}

async function readRecords(path: string, label: string): Promise<unknown[]> {
  const raw = path === "-" ? await readStdin() : await readFile(path, "utf8");
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Fall through to newline-delimited JSON.
  }
  try {
    return raw
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    throw new Error(`Unable to parse ${label} input.`);
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function trackEndpoint(apiUrl: string): string {
  let base: URL;
  try {
    base = new URL(apiUrl);
  } catch {
    throw new Error("OPENPANEL_API_URL is invalid.");
  }
  const loopbackHttp = base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(base.hostname);
  if (base.protocol !== "https:" && !loopbackHttp) {
    throw new Error("OpenPanel backfill requires an HTTPS API URL (HTTP is allowed only for loopback hosts).");
  }
  return new URL("track", `${base.toString().replace(/\/+$/u, "")}/`).toString();
}

function requiredIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) throw new Error(`Invalid ${label}.`);
  return normalized;
}

function parseAuthUser(value: unknown): BackfillAuthUser {
  if (!isDynamicRecord(value) || !isString(value.id) || !isString(value.email)) {
    throw new Error("Invalid auth user record.");
  }
  return { id: value.id, email: value.email };
}

function parseOpenPanelProfile(value: unknown): BackfillOpenPanelProfile {
  if (!isDynamicRecord(value) || !isString(value.profileId) || (value.email !== null && !isString(value.email))) {
    throw new Error("Invalid OpenPanel profile record.");
  }
  return { profileId: value.profileId, email: value.email };
}

function requiredEmail(value: string, label: string): string {
  const normalized = normalizeEmailAddress(value);
  if (!normalized) throw new Error(`Invalid ${label}.`);
  return normalized;
}

function requiredSecret(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`${label} is required for --apply.`);
  return value;
}

function nextArgument(args: readonly string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

const scriptPath = process.argv[1] ? fileURLToPath(import.meta.url) : "";
if (scriptPath && process.argv[1] === scriptPath) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : "OpenPanel backfill failed.");
    process.exitCode = 1;
  });
}
