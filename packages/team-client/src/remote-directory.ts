import { parseInviteUrl } from "@openbot/contracts/invite-links";
import { isMobileConnectDevelopmentHost } from "@openbot/contracts/mobile-connect";
import { isBoolean, isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";

import type { TeamClientFetch } from "./index";

export interface RemoteTeamHost {
  hostId: string;
  name: string;
  logoKey: string | null;
  devicePublicKey: string;
  membershipId: string;
  role: "owner" | "admin" | "member";
}

export interface RemoteTeamBootstrap {
  sessionId: string;
  expiresAt: number;
  signalUrl: string;
  ticket: string;
}

export interface RemoteInvitePreview {
  hostId: string;
  hostName: string;
  role: "admin" | "member";
  expiresAt: number;
  emailBound: boolean;
  devicePublicKey: string | null;
}

export class RemoteDirectoryError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class RemoteTeamDirectoryClient {
  readonly #apiUrl: string;
  readonly #token: string;
  readonly #fetch: TeamClientFetch;

  constructor(input: { apiUrl: string; token: string; fetch: TeamClientFetch }) {
    this.#apiUrl = input.apiUrl;
    this.#token = input.token;
    this.#fetch = input.fetch;
  }

  async listHosts(): Promise<RemoteTeamHost[]> {
    const value = await this.#request("/v2/remote/hosts/");
    if (!isDynamicRecord(value) || !Array.isArray(value.hosts)) throw new Error("The server list is invalid.");
    return value.hosts.flatMap((candidate) => {
      if (!isDynamicRecord(candidate) || !isString(candidate.devicePublicKey) || !candidate.devicePublicKey) return [];
      if (
        !isString(candidate.hostId) ||
        !isString(candidate.name) ||
        (candidate.logoKey !== null && !isString(candidate.logoKey)) ||
        !isString(candidate.membershipId) ||
        (candidate.role !== "owner" && candidate.role !== "admin" && candidate.role !== "member")
      ) {
        throw new Error("A server record is invalid.");
      }
      return [
        {
          hostId: candidate.hostId,
          name: candidate.name,
          logoKey: candidate.logoKey,
          devicePublicKey: candidate.devicePublicKey,
          membershipId: candidate.membershipId,
          role: candidate.role,
        },
      ];
    });
  }

  async createBootstrap(hostId: string, clientPublicKey: string): Promise<RemoteTeamBootstrap> {
    const session = await this.#request("/v2/remote/sessions/", {
      method: "POST",
      body: { hostId },
    });
    if (
      !isDynamicRecord(session) ||
      !isString(session.sessionId) ||
      !isNumber(session.expiresAt) ||
      !Number.isSafeInteger(session.expiresAt)
    ) {
      throw new Error("The remote session is invalid.");
    }
    try {
      const ticket = await this.#request(`/v2/remote/sessions/${encodeURIComponent(session.sessionId)}/ticket`, {
        method: "POST",
        body: { clientPublicKey },
      });
      if (
        !isDynamicRecord(ticket) ||
        !isString(ticket.ticket) ||
        !isString(ticket.signalUrl) ||
        !isNumber(ticket.expiresAt)
      ) {
        throw new Error("The connection ticket is invalid.");
      }
      const signalUrl = new URL(ticket.signalUrl);
      if (
        signalUrl.protocol !== "wss:" &&
        !(signalUrl.protocol === "ws:" && isMobileConnectDevelopmentHost(signalUrl.hostname))
      ) {
        throw new Error("The Signal URL is invalid.");
      }
      return {
        sessionId: session.sessionId,
        expiresAt: session.expiresAt,
        signalUrl: ticket.signalUrl,
        ticket: ticket.ticket,
      };
    } catch (error) {
      await this.endSession(session.sessionId).catch(() => undefined);
      throw error;
    }
  }

  async endSession(sessionId: string): Promise<void> {
    await this.#request(`/v2/remote/sessions/${encodeURIComponent(sessionId)}/end`, { method: "POST" });
  }

  async previewInvite(inviteUrl: string): Promise<RemoteInvitePreview> {
    const invite = parseInviteUrl(inviteUrl);
    if (new URL(invite.apiUrl).origin !== new URL(this.#apiUrl).origin) {
      throw new Error("This invitation belongs to another OpenBot service.");
    }
    const value = await this.#request("/v2/remote/invites/preview", {
      method: "POST",
      body: { token: invite.token },
      authenticated: false,
    });
    return decodeInvitePreview(value, invite.serverId);
  }

  async acceptInvite(inviteUrl: string): Promise<RemoteInvitePreview> {
    const invite = parseInviteUrl(inviteUrl);
    const preview = await this.previewInvite(inviteUrl);
    await this.#request("/v2/remote/invites/accept", {
      method: "POST",
      body: { token: invite.token },
    });
    return preview;
  }

  async #request(
    path: string,
    options: { method?: string; body?: object; authenticated?: boolean } = {},
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await this.#fetch(new URL(path, this.#apiUrl), {
        method: options.method ?? "GET",
        headers: {
          ...(options.authenticated === false ? {} : { Authorization: `Bearer ${this.#token}` }),
          ...(options.body ? { "Content-Type": "application/json" } : {}),
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        signal: controller.signal,
      });
      const value = await response.json().catch(() => null);
      if (!response.ok) throw new RemoteDirectoryError(response.status, errorMessage(value));
      return value;
    } finally {
      clearTimeout(timer);
    }
  }
}

function decodeInvitePreview(value: unknown, expectedHostId: string): RemoteInvitePreview {
  if (
    !isDynamicRecord(value) ||
    value.hostId !== expectedHostId ||
    !isString(value.hostName) ||
    (value.role !== "admin" && value.role !== "member") ||
    !isNumber(value.expiresAt) ||
    !isBoolean(value.emailBound) ||
    (value.devicePublicKey !== null && !isString(value.devicePublicKey))
  ) {
    throw new Error("The invitation preview is invalid.");
  }
  return {
    hostId: expectedHostId,
    hostName: value.hostName,
    role: value.role,
    expiresAt: value.expiresAt,
    emailBound: value.emailBound,
    devicePublicKey: value.devicePublicKey,
  };
}

function errorMessage(value: unknown): string {
  if (isDynamicRecord(value)) {
    if (isString(value.error)) return value.error;
    if (isDynamicRecord(value.error) && isString(value.error.message)) return value.error.message;
  }
  return "The OpenBot service request failed.";
}
