import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { isUuidV4, isValidHostname, slugifyTeamServerName } from "@openbot/contracts/validation";

import type { AuthUser } from "./types";

export interface TeamTunnelRecord {
  serverId: string;
  userId: string;
  tunnelId: string | null;
  tunnelName: string;
  apiHostname: string;
  status: "provisioning" | "active";
}

export interface TeamTunnelRepository {
  claim(input: Omit<TeamTunnelRecord, "tunnelId" | "status"> & { now: number }): Promise<TeamTunnelRecord>;
  setTunnelId(serverId: string, tunnelId: string, now: number): Promise<void>;
  markActive(serverId: string, now: number): Promise<void>;
  setMachineTokenHash(serverId: string, tokenHash: string, now: number): Promise<void>;
  authenticateMachine(serverId: string, tokenHash: string): Promise<boolean>;
  find(serverId: string): Promise<TeamTunnelRecord | null>;
  delete(serverId: string): Promise<void>;
}

export interface TeamTunnelProvider {
  findTunnelId(name: string): Promise<string | null>;
  createTunnel(name: string): Promise<string>;
  configureTunnel(input: { tunnelId: string; apiHostname: string; apiPort: number | null }): Promise<void>;
  ensureDns(hostname: string, tunnelId: string): Promise<void>;
  getTunnelToken(tunnelId: string): Promise<string>;
  deleteDns(hostname: string): Promise<void>;
  deleteTunnel(tunnelId: string): Promise<void>;
}

export interface ProvisionedTeamTunnel {
  tunnelId: string;
  tunnelName: string;
  apiUrl: string;
  token: string;
  machineToken: string;
}

interface TeamTunnelServiceOptions {
  repository: TeamTunnelRepository;
  provider: TeamTunnelProvider;
  domain: string;
  now?: () => number;
  randomSuffix?: () => string;
}

const MAX_HOSTNAME_ATTEMPTS = 10;
const HOST_SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const MAX_HOST_SLUG_LENGTH = 44;

export class TeamTunnelService {
  readonly #repository: TeamTunnelRepository;
  readonly #provider: TeamTunnelProvider;
  readonly #domain: string;
  readonly #now: () => number;
  readonly #randomSuffix: () => string;

  constructor(options: TeamTunnelServiceOptions) {
    this.#repository = options.repository;
    this.#provider = options.provider;
    this.#domain = normalizeDomain(options.domain);
    this.#now = options.now ?? Date.now;
    this.#randomSuffix = options.randomSuffix ?? createRandomHostSuffix;
  }

  async provision(input: {
    user: AuthUser;
    serverId: string;
    serverName: string;
    apiPort?: number | null;
  }): Promise<ProvisionedTeamTunnel> {
    validateServerId(input.serverId);
    const slug = validateServerName(input.serverName);
    const apiPort = input.apiPort ?? null;
    if (apiPort !== null && (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65_535)) {
      throw new TeamTunnelServiceError(400, "invalid_api_port", "The host API port is invalid.");
    }
    const compactId = input.serverId.replaceAll("-", "").toLowerCase();
    const now = this.#now();
    const serverId = input.serverId.toLowerCase();
    let claimed: TeamTunnelRecord | null = null;
    for (let attempt = 0; attempt < MAX_HOSTNAME_ATTEMPTS; attempt += 1) {
      const apiHostname = buildTeamHostname(slug, this.#randomSuffix(), this.#domain);
      try {
        claimed = await this.#repository.claim({
          serverId,
          userId: input.user.id,
          tunnelName: `openbot-${compactId}`,
          apiHostname,
          now,
        });
        break;
      } catch (error) {
        if (!(error instanceof TeamTunnelClaimConflict) || attempt === MAX_HOSTNAME_ATTEMPTS - 1) {
          throw error instanceof TeamTunnelClaimConflict
            ? new TeamTunnelServiceError(
                503,
                "team_tunnel_hostname_unavailable",
                "A unique OpenBot host address could not be reserved.",
              )
            : error;
        }
      }
    }
    if (!claimed) throw new Error("The team tunnel claim could not be stored.");
    if (claimed.userId !== input.user.id) {
      throw new TeamTunnelServiceError(
        403,
        "team_tunnel_owner_mismatch",
        "This team server belongs to a different OpenBot account.",
      );
    }
    if (claimed.serverId !== input.serverId.toLowerCase()) {
      throw new TeamTunnelServiceError(
        409,
        "team_server_limit_reached",
        "This OpenBot account already owns a team server.",
      );
    }

    let tunnelId = claimed.tunnelId;
    if (!tunnelId) {
      tunnelId = await this.#provider.findTunnelId(claimed.tunnelName);
      if (!tunnelId) {
        try {
          tunnelId = await this.#provider.createTunnel(claimed.tunnelName);
        } catch (error) {
          tunnelId = await this.#provider.findTunnelId(claimed.tunnelName);
          if (!tunnelId) throw error;
        }
      }
      await this.#repository.setTunnelId(claimed.serverId, tunnelId, now);
    }

    await this.#provider.configureTunnel({
      tunnelId,
      apiHostname: claimed.apiHostname,
      apiPort,
    });
    await this.#provider.ensureDns(claimed.apiHostname, tunnelId);
    const token = await this.#provider.getTunnelToken(tunnelId);
    const machineToken = createMachineToken();
    await this.#repository.setMachineTokenHash(claimed.serverId, await hashMachineToken(machineToken), now);
    await this.#repository.markActive(claimed.serverId, now);
    return {
      tunnelId,
      tunnelName: claimed.tunnelName,
      apiUrl: `https://${claimed.apiHostname}`,
      token,
      machineToken,
    };
  }

  async deprovision(user: AuthUser, serverId: string): Promise<void> {
    validateServerId(serverId);
    const record = await this.#repository.find(serverId.toLowerCase());
    if (!record) return;
    if (record.userId !== user.id) {
      throw new TeamTunnelServiceError(
        403,
        "team_tunnel_owner_mismatch",
        "This team server belongs to a different OpenBot account.",
      );
    }
    await this.#provider.deleteDns(record.apiHostname);
    const tunnelId = record.tunnelId ?? (await this.#provider.findTunnelId(record.tunnelName));
    if (tunnelId) await this.#provider.deleteTunnel(tunnelId);
    await this.#repository.delete(record.serverId);
  }
}

export async function authenticateTeamHost(
  repository: TeamTunnelRepository,
  serverId: string,
  machineToken: string,
): Promise<boolean> {
  validateServerId(serverId);
  if (!/^[0-9a-f]{64}$/u.test(machineToken)) return false;
  return repository.authenticateMachine(serverId.toLowerCase(), await hashMachineToken(machineToken));
}

function createMachineToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function hashMachineToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export class TeamTunnelServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class TeamTunnelClaimConflict extends Error {
  constructor() {
    super("team_tunnel_hostname_conflict");
  }
}

function validateServerId(value: string): void {
  if (!isUuidV4(value)) {
    throw new TeamTunnelServiceError(400, "invalid_server_id", "The team server ID is invalid.");
  }
}

function validateServerName(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length < INPUT_LIMITS.serverNameMin ||
    normalized.length > INPUT_LIMITS.serverName ||
    /[\r\n]/u.test(normalized)
  ) {
    throw new TeamTunnelServiceError(400, "invalid_server_name", "The team server name is invalid.");
  }
  const slug = slugifyTeamServerName(normalized);
  if (slug.length < INPUT_LIMITS.serverNameMin) {
    throw new TeamTunnelServiceError(
      400,
      "invalid_server_name",
      "The team server name must produce a valid public hostname.",
    );
  }
  return slug.slice(0, MAX_HOST_SLUG_LENGTH).replace(/-+$/gu, "");
}

function buildTeamHostname(slug: string, suffix: string, domain: string): string {
  if (!/^[a-z2-7]{8}$/u.test(suffix)) {
    throw new Error("The generated team tunnel suffix is invalid.");
  }
  return `${slug}-${suffix}-host.${domain}`;
}

function createRandomHostSuffix(): string {
  const bytes = new Uint8Array(5);
  globalThis.crypto.getRandomValues(bytes);
  let buffer = 0;
  let bits = 0;
  let suffix = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      suffix += HOST_SUFFIX_ALPHABET[(buffer >>> bits) & 31];
    }
  }
  return suffix;
}

function normalizeDomain(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/gu, "");
  if (normalized.length > INPUT_LIMITS.hostname || !isValidHostname(normalized)) {
    throw new Error("The Cloudflare tunnel domain is invalid.");
  }
  return normalized;
}
