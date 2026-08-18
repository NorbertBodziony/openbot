import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { isUuidV4, isValidHostname } from "@openbot/contracts/validation";

import type { AuthUser } from "./types";

export interface TeamTunnelRecord {
  serverId: string;
  userId: string;
  tunnelId: string | null;
  tunnelName: string;
  apiHostname: string;
  vncHostname: string;
  status: "provisioning" | "active";
}

export interface TeamTunnelRepository {
  claim(
    input: Omit<TeamTunnelRecord, "tunnelId" | "status"> & { now: number },
  ): Promise<TeamTunnelRecord>;
  setTunnelId(serverId: string, tunnelId: string, now: number): Promise<void>;
  markActive(serverId: string, now: number): Promise<void>;
  find(serverId: string): Promise<TeamTunnelRecord | null>;
  delete(serverId: string): Promise<void>;
}

export interface TeamTunnelProvider {
  findTunnelId(name: string): Promise<string | null>;
  createTunnel(name: string): Promise<string>;
  configureTunnel(input: {
    tunnelId: string;
    apiHostname: string;
    vncHostname: string;
    apiPort: number | null;
    vncEnabled: boolean;
  }): Promise<void>;
  ensureDns(hostname: string, tunnelId: string): Promise<void>;
  getTunnelToken(tunnelId: string): Promise<string>;
  deleteDns(hostname: string): Promise<void>;
  deleteTunnel(tunnelId: string): Promise<void>;
}

export interface ProvisionedTeamTunnel {
  tunnelId: string;
  tunnelName: string;
  apiUrl: string;
  vncHostname: string;
  token: string;
}

interface TeamTunnelServiceOptions {
  repository: TeamTunnelRepository;
  provider: TeamTunnelProvider;
  domain: string;
  now?: () => number;
}

export class TeamTunnelService {
  readonly #repository: TeamTunnelRepository;
  readonly #provider: TeamTunnelProvider;
  readonly #domain: string;
  readonly #now: () => number;

  constructor(options: TeamTunnelServiceOptions) {
    this.#repository = options.repository;
    this.#provider = options.provider;
    this.#domain = normalizeDomain(options.domain);
    this.#now = options.now ?? Date.now;
  }

  async provision(input: {
    user: AuthUser;
    serverId: string;
    serverName: string;
    apiPort?: number | null;
    vncEnabled?: boolean;
  }): Promise<ProvisionedTeamTunnel> {
    validateServerId(input.serverId);
    validateServerName(input.serverName);
    const apiPort = input.apiPort ?? null;
    if (apiPort !== null && (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65_535)) {
      throw new TeamTunnelServiceError(400, "invalid_api_port", "The host API port is invalid.");
    }
    const compactId = input.serverId.replaceAll("-", "").toLowerCase();
    const now = this.#now();
    const claimed = await this.#repository.claim({
      serverId: input.serverId.toLowerCase(),
      userId: input.user.id,
      tunnelName: `openbot-${compactId}`,
      apiHostname: `h-${compactId}.${this.#domain}`,
      vncHostname: `vnc-h-${compactId}.${this.#domain}`,
      now,
    });
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
      vncHostname: claimed.vncHostname,
      apiPort,
      vncEnabled: input.vncEnabled ?? false,
    });
    await Promise.all([
      this.#provider.ensureDns(claimed.apiHostname, tunnelId),
      this.#provider.ensureDns(claimed.vncHostname, tunnelId),
    ]);
    const token = await this.#provider.getTunnelToken(tunnelId);
    await this.#repository.markActive(claimed.serverId, now);
    return {
      tunnelId,
      tunnelName: claimed.tunnelName,
      apiUrl: `https://${claimed.apiHostname}`,
      vncHostname: claimed.vncHostname,
      token,
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
    await Promise.all([
      this.#provider.deleteDns(record.apiHostname),
      this.#provider.deleteDns(record.vncHostname),
    ]);
    const tunnelId = record.tunnelId ?? (await this.#provider.findTunnelId(record.tunnelName));
    if (tunnelId) await this.#provider.deleteTunnel(tunnelId);
    await this.#repository.delete(record.serverId);
  }
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

function validateServerId(value: string): void {
  if (!isUuidV4(value)) {
    throw new TeamTunnelServiceError(400, "invalid_server_id", "The team server ID is invalid.");
  }
}

function validateServerName(value: string): void {
  const normalized = value.trim();
  if (
    normalized.length < 2 ||
    normalized.length > INPUT_LIMITS.serverName ||
    /[\r\n]/u.test(normalized)
  ) {
    throw new TeamTunnelServiceError(
      400,
      "invalid_server_name",
      "The team server name is invalid.",
    );
  }
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
