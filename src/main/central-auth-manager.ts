import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  AvatarImageInput,
  CentralAuthIssue,
  CentralAuthState,
  CentralAuthUser,
  MobileConnectedDevice,
  MobileConnectTicket,
} from "@openbot/contracts/ipc";
import {
  createMobileConnectUrl,
  isMobileConnectDevelopmentHost,
  type MobileConnectHostBinding,
} from "@openbot/contracts/mobile-connect";
import { type DynamicRecord, isBoolean, isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import { createLocalJWKSet, jwtVerify } from "jose";
import { z } from "zod";

interface CentralAuthEvents {
  changed: [state: CentralAuthState];
}

type AuthFetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface CentralAuthManagerOptions {
  apiUrl: string;
  mobileConnectApiUrl?: string;
  storagePath: string;
  encrypt: (value: string) => Buffer;
  decrypt: (value: Buffer) => string;
  canPersist?: () => boolean;
  fetch?: AuthFetcher;
  startupRetryWindowMs?: number;
  startupRequestTimeoutMs?: number;
  startupRetryDelaysMs?: readonly number[];
  emailCodeRequestTimeoutMs?: number;
}

interface EmailCodeRequest {
  email: string;
  idempotencyKey: string;
  promise: Promise<CentralAuthState> | null;
}

interface SessionResponse {
  sessionToken: string;
  user: CentralAuthUser;
}

const STARTUP_RETRY_WINDOW_MS = 30_000;
const STARTUP_REQUEST_TIMEOUT_MS = 3_000;
const STARTUP_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000] as const;
const EMAIL_CODE_REQUEST_TIMEOUT_MS = 35_000;
const RESEND_FALLBACK_DELAY_MS = 60_000;
const DEFINITIVE_EMAIL_CODE_REQUEST_FAILURES = new Set([
  "email_delivery_failed",
  "idempotency_conflict",
  "idempotency_key_completed",
  "invalid_email",
  "invalid_idempotency_key",
  "sign_in_code_expired",
]);
const UNCERTAIN_EMAIL_CODE_REQUEST_FAILURES = new Set([
  "email_delivery_pending",
  "email_delivery_timeout",
  "email_delivery_unknown",
]);
const AUTH_API_UNAVAILABLE_MESSAGE =
  "OpenBot could not reach the account service. Check that the API is running, then try again.";
const remoteTicketJwksSchema = z.object({
  keys: z.array(z.object({ kty: z.string() }).loose()).min(1),
});

export interface RegisteredRemoteHost {
  hostId: string;
  name: string;
  membershipId: string;
  authEpoch: number;
  machineToken: string | null;
}

export interface RemoteConnectionBootstrap {
  ticket: string;
  expiresAt: number;
  signalUrl: string;
}

export interface VerifiedRemoteSessionTicket {
  sessionId: string;
  hostId: string;
  userId: string;
  membershipId: string;
  role: "owner" | "admin" | "member";
  authEpoch: number;
  sessionExpiresAt: number;
  clientPublicKey: string;
}

export interface RemoteHostSummary {
  hostId: string;
  name: string;
  logoKey: string | null;
  devicePublicKey: string | null;
  authEpoch: number;
  membershipId: string;
  role: "owner" | "admin" | "member";
}

export interface RemoteInviteRecord {
  inviteId: string;
  email: string | null;
  role: "admin" | "member";
  expiresAt: number;
  usedAt: number | null;
  revokedAt: number | null;
}

export interface RemoteInvitePreview {
  inviteId: string;
  hostId: string;
  hostName: string;
  role: "admin" | "member";
  expiresAt: number;
  emailBound: boolean;
  devicePublicKey: string | null;
}

export interface RemoteMemberRecord {
  membershipId: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  role: "owner" | "admin" | "member";
  status: "active" | "revoked";
  createdAt: number;
}

export class CentralAuthManager extends EventEmitter<CentralAuthEvents> {
  readonly #options: Required<CentralAuthManagerOptions>;
  #state: CentralAuthState = { status: "loading" };
  #sessionToken: string | null = null;
  readonly #teamHostTokens = new Map<string, string>();
  #sessionWriteChain: Promise<void> = Promise.resolve();
  /** The account the stored host credentials were issued to, or none while signed out. */
  #sessionAccountId: string | null = null;
  #remoteTicketJwks: Promise<z.infer<typeof remoteTicketJwksSchema>> | null = null;
  #initializationPromise: Promise<CentralAuthState> | null = null;
  #emailCodeRequest: EmailCodeRequest | null = null;

  constructor(options: CentralAuthManagerOptions) {
    super();
    this.#options = {
      ...options,
      mobileConnectApiUrl: options.mobileConnectApiUrl ?? options.apiUrl,
      canPersist: options.canPersist ?? (() => true),
      fetch: options.fetch ?? fetch,
      startupRetryWindowMs: options.startupRetryWindowMs ?? STARTUP_RETRY_WINDOW_MS,
      startupRequestTimeoutMs: options.startupRequestTimeoutMs ?? STARTUP_REQUEST_TIMEOUT_MS,
      startupRetryDelaysMs: options.startupRetryDelaysMs ?? STARTUP_RETRY_DELAYS_MS,
      emailCodeRequestTimeoutMs: options.emailCodeRequestTimeoutMs ?? EMAIL_CODE_REQUEST_TIMEOUT_MS,
    };
  }

  getState(): CentralAuthState {
    return structuredClone(this.#state);
  }

  getSignedInUser(): CentralAuthUser {
    if (this.#state.status !== "signed_in") {
      throw new AuthApiError(401, "unauthorized", "Sign in to OpenBot first.");
    }
    return structuredClone(this.#state.user);
  }

  resolveApiUrl(path: string): string {
    return new URL(path, this.#options.apiUrl).toString();
  }

  requestAuthorized<T>(
    path: string,
    init: RequestInit,
    decoder: (value: unknown) => T,
    timeoutMs?: number,
  ): Promise<T> {
    return this.#authorizedRequest(path, init, decoder, timeoutMs);
  }

  async downloadAuthorized(path: string, timeoutMs = 30_000): Promise<Uint8Array> {
    if (!this.#sessionToken) throw new AuthApiError(401, "unauthorized", "Sign in is required.");
    const response = await this.#options.fetch(new URL(path, this.#options.apiUrl), {
      headers: { Authorization: `Bearer ${this.#sessionToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw await AuthApiError.fromResponse(response);
    return new Uint8Array(await response.arrayBuffer());
  }

  async createTeamAuthTicket(serverId: string): Promise<string> {
    const result = await this.#authorizedRequest(
      "/v1/team-auth/ticket",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId }),
      },
      decodeTicketResponse,
    );
    if (!result.ticket || !Number.isFinite(result.expiresAt)) {
      throw new Error("The account service returned an invalid team ticket.");
    }
    return result.ticket;
  }

  async createMobileConnect(host: MobileConnectHostBinding): Promise<MobileConnectTicket> {
    const result = await this.#authorizedRequest(
      "/v1/mobile-auth/ticket",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host }),
      },
      decodeTicketResponse,
    );
    if (!result.ticket || !Number.isFinite(result.expiresAt) || result.expiresAt <= Date.now()) {
      throw new Error("The account service returned an invalid Mobile Connect ticket.");
    }
    return {
      qrData: createMobileConnectUrl({ apiUrl: this.#options.mobileConnectApiUrl, ticket: result.ticket, host }),
      expiresAt: result.expiresAt,
    };
  }

  async listMobileConnectedDevices(): Promise<MobileConnectedDevice[]> {
    const result = await this.#authorizedRequest(
      "/v1/mobile-auth/devices",
      { method: "GET" },
      decodeMobileConnectedDevices,
    );
    return result.devices;
  }

  async listAccountSessions() {
    const result = await this.#authorizedRequest(
      "/v1/mobile-auth/devices?includeDesktop=true",
      { method: "GET" },
      (value) =>
        z
          .object({
            sessions: z.array(
              z.object({
                sessionId: z.string().uuid(),
                name: z.string(),
                kind: z.enum(["desktop", "mobile"]),
                current: z.boolean(),
                connectedAt: z.number().finite(),
                lastActiveAt: z.number().finite(),
              }),
            ),
          })
          .parse(value),
    );
    return result.sessions;
  }

  async revokeAccountSession(sessionId: string): Promise<void> {
    await this.#authorizedRequest(
      `/v1/mobile-auth/devices/${encodeURIComponent(sessionId)}?includeDesktop=true`,
      { method: "DELETE" },
      () => undefined,
    );
  }

  async revokeMobileConnectedDevice(sessionId: string): Promise<void> {
    await this.#authorizedRequest(
      `/v1/mobile-auth/devices/${encodeURIComponent(sessionId)}`,
      { method: "DELETE" },
      () => undefined,
    );
  }

  async registerRemoteHost(input: {
    hostId: string;
    name: string;
    ownerMembershipId: string;
    devicePublicKey?: string | null;
  }): Promise<RegisteredRemoteHost> {
    const sessionToken = this.#sessionToken;
    const storedMachineToken = this.#teamHostTokens.get(input.hostId.toLowerCase());
    const result = await this.#authorizedRequest(
      "/v2/remote/hosts/register",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...input,
          rotateCredential: !storedMachineToken,
          ...(storedMachineToken ? { machineToken: storedMachineToken } : {}),
        }),
      },
      decodeRegisteredRemoteHost,
    );
    if (this.#sessionToken !== sessionToken) {
      // The credential belongs to the account that asked for it. Writing it now would file
      // it under whichever session is stored next, so the caller is told the registration
      // no longer applies instead.
      throw new Error("The signed-in account changed while this server was being registered.");
    }
    if (result.machineToken) this.#teamHostTokens.set(input.hostId.toLowerCase(), result.machineToken);
    await this.#writeStoredSession();
    return result;
  }

  issueRemoteHostTicket(hostId: string): Promise<RemoteConnectionBootstrap> {
    const machineToken = this.#teamHostTokens.get(hostId.toLowerCase());
    if (!machineToken) throw new Error("The remote host credential is unavailable. Register the host again.");
    return this.#request(
      `/v2/remote/hosts/${encodeURIComponent(hostId)}/ticket`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ machineToken }) },
      decodeRemoteConnectionBootstrap,
    );
  }

  async startRemoteSession(hostId: string): Promise<{ sessionId: string; hostId: string; expiresAt: number }> {
    return this.#authorizedRequest(
      "/v2/remote/sessions/",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hostId }) },
      decodeRemoteSession,
    );
  }

  listRemoteHosts(): Promise<RemoteHostSummary[]> {
    return this.#authorizedRequest("/v2/remote/hosts/", { method: "GET" }, decodeRemoteHosts);
  }

  issueRemoteSessionTicket(sessionId: string, clientPublicKey: string): Promise<RemoteConnectionBootstrap> {
    return this.#authorizedRequest(
      `/v2/remote/sessions/${encodeURIComponent(sessionId)}/ticket`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientPublicKey }),
      },
      decodeRemoteConnectionBootstrap,
    );
  }

  async verifyRemoteSessionTicket(ticket: string): Promise<VerifiedRemoteSessionTicket> {
    const verify = async () => {
      if (!this.#remoteTicketJwks) this.#remoteTicketJwks = this.#fetchRemoteTicketJwks();
      const jwks = await this.#remoteTicketJwks;
      return jwtVerify(ticket, createLocalJWKSet(jwks), {
        audience: "openbot-remote",
        algorithms: ["ES256"],
      });
    };
    let payload: Awaited<ReturnType<typeof verify>>["payload"];
    try {
      ({ payload } = await verify());
    } catch (error) {
      if (!isDynamicRecord(error) || error.code !== "ERR_JWKS_NO_MATCHING_KEY") throw error;
      this.#remoteTicketJwks = null;
      ({ payload } = await verify());
    }
    if (
      !isString(payload.sessionId) ||
      !isString(payload.hostId) ||
      !isString(payload.userId) ||
      !isString(payload.membershipId) ||
      (payload.role !== "owner" && payload.role !== "admin" && payload.role !== "member") ||
      !isNumber(payload.authEpoch) ||
      !Number.isInteger(payload.authEpoch) ||
      !isNumber(payload.sessionExpiresAt) ||
      !Number.isInteger(payload.sessionExpiresAt) ||
      !isString(payload.clientPublicKey)
    ) {
      throw new Error("The remote session ticket has invalid claims.");
    }
    return {
      sessionId: payload.sessionId,
      hostId: payload.hostId,
      userId: payload.userId,
      membershipId: payload.membershipId,
      role: payload.role,
      authEpoch: payload.authEpoch,
      sessionExpiresAt: payload.sessionExpiresAt,
      clientPublicKey: payload.clientPublicKey,
    };
  }

  async #fetchRemoteTicketJwks(): Promise<z.infer<typeof remoteTicketJwksSchema>> {
    const response = await this.#options.fetch(new URL("/.well-known/jwks.json", this.#options.apiUrl), {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw await AuthApiError.fromResponse(response);
    return remoteTicketJwksSchema.parse(await response.json());
  }

  endRemoteSession(sessionId: string): Promise<void> {
    return this.#authorizedRequest(
      `/v2/remote/sessions/${encodeURIComponent(sessionId)}/end`,
      { method: "POST" },
      decodeVoid,
    );
  }

  createRemoteInvite(
    hostId: string,
    input: { role: "admin" | "member"; email?: string },
  ): Promise<{ inviteId: string; token: string; expiresAt: number }> {
    return this.#authorizedRequest(
      `/v2/remote/hosts/${encodeURIComponent(hostId)}/invites`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) },
      decodeCreatedRemoteInvite,
    );
  }

  listRemoteInvites(hostId: string): Promise<RemoteInviteRecord[]> {
    return this.#authorizedRequest(
      `/v2/remote/hosts/${encodeURIComponent(hostId)}/invites`,
      { method: "GET" },
      decodeRemoteInvites,
    );
  }

  previewRemoteInvite(token: string): Promise<RemoteInvitePreview> {
    return this.#request(
      "/v2/remote/invites/preview",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) },
      decodeRemoteInvitePreview,
    );
  }

  acceptRemoteInvite(token: string): Promise<{ hostId: string; membershipId: string; role: "admin" | "member" }> {
    return this.#authorizedRequest(
      "/v2/remote/invites/accept",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) },
      decodeAcceptedRemoteInvite,
    );
  }

  revokeRemoteInvite(inviteId: string): Promise<void> {
    return this.#authorizedRequest(
      `/v2/remote/invites/${encodeURIComponent(inviteId)}`,
      { method: "DELETE" },
      decodeVoid,
    );
  }

  async listRemoteMembers(hostId: string): Promise<RemoteMemberRecord[]> {
    const members = await this.#authorizedRequest(
      `/v2/remote/hosts/${encodeURIComponent(hostId)}/members/`,
      { method: "GET" },
      decodeRemoteMembers,
    );
    return members.map((member) => ({
      ...member,
      avatarUrl: member.avatarUrl ? this.resolveApiUrl(member.avatarUrl) : null,
    }));
  }

  updateRemoteMember(
    hostId: string,
    membershipId: string,
    role: "admin" | "member",
    reactivate = false,
  ): Promise<void> {
    return this.#authorizedRequest(
      `/v2/remote/hosts/${encodeURIComponent(hostId)}/members/${encodeURIComponent(membershipId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role, ...(reactivate ? { reactivate: true } : {}) }),
      },
      decodeVoid,
    );
  }

  removeRemoteMember(hostId: string, membershipId: string): Promise<void> {
    return this.#authorizedRequest(
      `/v2/remote/hosts/${encodeURIComponent(hostId)}/members/${encodeURIComponent(membershipId)}`,
      { method: "DELETE" },
      decodeVoid,
    );
  }

  async updateRemoteHostLogo(
    hostId: string,
    image: AvatarImageInput | null,
    version?: string | null,
  ): Promise<string | null> {
    if (image === null) {
      await this.#authorizedRequest(
        `/v2/remote/hosts/${encodeURIComponent(hostId)}/logo`,
        { method: "DELETE" },
        decodeVoid,
      );
      return null;
    }
    return this.#authorizedRequest(
      `/v2/remote/hosts/${encodeURIComponent(hostId)}/logo`,
      {
        method: "PUT",
        headers: { "Content-Type": image.mimeType, ...(version ? { "OpenBot-Logo-Version": version } : {}) },
        body: Buffer.from(image.bytes),
      },
      (value) => requiredString(decodeRecord(value, "remote host logo"), "logoKey"),
    );
  }

  async downloadRemoteHostLogo(hostId: string, version: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
    if (!this.#sessionToken) throw new AuthApiError(401, "unauthorized", "Sign in is required.");
    const url = new URL(`/v2/remote/hosts/${encodeURIComponent(hostId)}/logo`, this.#options.apiUrl);
    url.searchParams.set("v", version);
    const response = await this.#options.fetch(url, {
      headers: { Authorization: `Bearer ${this.#sessionToken}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw await AuthApiError.fromResponse(response);
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      mimeType: response.headers.get("content-type")?.split(";", 1)[0]?.trim() || "application/octet-stream",
    };
  }

  async redeemTeamAuthTicket(ticket: string, serverId: string): Promise<CentralAuthUser | null> {
    if (!ticket) return null;
    try {
      const user = await this.#request(
        "/v1/team-auth/redeem",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ticket, serverId }),
        },
        decodeCentralAuthUser,
      );
      return this.#resolveUserAvatar(user);
    } catch (error) {
      if (error instanceof AuthApiError && error.status === 401) return null;
      throw error;
    }
  }

  sendTeamInviteEmail(input: {
    email: string;
    serverName: string;
    inviteUrl: string;
    role: "admin" | "member";
  }): Promise<void> {
    return this.#authorizedRequest(
      "/v1/team-invitations/email",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
      decodeVoid,
    );
  }

  initialize(): Promise<CentralAuthState> {
    if (this.#initializationPromise) return this.#initializationPromise;
    const pending = this.#initialize().catch((error) => this.#setInitializationError(error));
    this.#initializationPromise = pending;
    void pending.then(() => {
      if (this.#initializationPromise === pending) this.#initializationPromise = null;
    });
    return pending;
  }

  retry(): Promise<CentralAuthState> {
    return this.initialize();
  }

  async #initialize(): Promise<CentralAuthState> {
    this.#setState({ status: "loading" });
    if (this.#options.canPersist()) {
      try {
        const encrypted = Buffer.from(await readFile(this.#options.storagePath, "utf8"), "base64");
        this.#restoreStoredSession(this.#options.decrypt(encrypted));
      } catch (error) {
        if (!isMissing(error)) {
          await this.#clearStoredSession();
        }
      }
    } else {
      await rm(this.#options.storagePath, { force: true });
    }
    if (!this.#sessionToken) {
      await this.#startupRequest("/health/live", { method: "GET" }, decodeRecordHealth);
      return this.#setState({ status: "signed_out" });
    }
    try {
      const user = await this.#startupRequest("/v1/me", { method: "GET" }, decodeCentralAuthUser, this.#sessionToken);
      return this.#setState({ status: "signed_in", user: this.#resolveUserAvatar(user) });
    } catch (error) {
      if (error instanceof AuthApiError && error.status === 401) {
        await this.#clearStoredSession();
        return this.#setState({ status: "signed_out" });
      }
      throw error;
    }
  }

  requestEmailCode(email: string): Promise<CentralAuthState> {
    const normalizedEmail = email.trim().toLowerCase();
    const existingRequest = this.#emailCodeRequest;
    if (existingRequest?.email === normalizedEmail && existingRequest.promise) return existingRequest.promise;

    const request: EmailCodeRequest =
      existingRequest?.email === normalizedEmail
        ? existingRequest
        : { email: normalizedEmail, idempotencyKey: randomUUID(), promise: null };
    this.#emailCodeRequest = request;
    const pending = this.#performEmailCodeRequest(request);
    request.promise = pending;
    return pending;
  }

  async #performEmailCodeRequest(request: EmailCodeRequest): Promise<CentralAuthState> {
    const existingChallenge = this.#state.status === "code_sent" ? this.#state : null;
    if (existingChallenge) {
      this.#setState({ ...existingChallenge, issue: undefined });
    } else {
      this.#setState({ status: "signing_in" });
    }
    try {
      const result = await this.#request(
        "/v1/auth/email/start",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": request.idempotencyKey,
          },
          body: JSON.stringify({ email: request.email }),
        },
        decodeEmailChallenge,
        this.#options.emailCodeRequestTimeoutMs,
      );
      if (!result.challengeId || !Number.isFinite(result.expiresAt)) {
        throw new Error("The account service returned an invalid sign-in challenge.");
      }
      if (this.#emailCodeRequest === request) this.#emailCodeRequest = null;
      return this.#setState({
        status: "code_sent",
        challengeId: result.challengeId,
        email: request.email,
        expiresAt: result.expiresAt,
        resendAvailableAt: result.resendAt ?? Math.min(result.expiresAt, Date.now() + RESEND_FALLBACK_DELAY_MS),
        ...(result.developmentCode ? { developmentCode: result.developmentCode } : {}),
      });
    } catch (error) {
      if (isDefinitiveEmailCodeRequestFailure(error) && this.#emailCodeRequest === request) {
        this.#emailCodeRequest = null;
      }
      const issue = emailCodeRequestIssue(error);
      if (existingChallenge && !UNCERTAIN_EMAIL_CODE_REQUEST_FAILURES.has(issue.code)) {
        return this.#setState({ ...existingChallenge, issue });
      }
      return this.#setState({
        status: "error",
        issue,
      });
    } finally {
      if (this.#emailCodeRequest === request) request.promise = null;
    }
  }

  async verifyEmailCode(challengeId: string, code: string): Promise<CentralAuthState> {
    const challenge = this.#state.status === "code_sent" ? this.#state : null;
    if (challenge) this.#setState({ ...challenge, issue: undefined });
    try {
      const session = await this.#request(
        "/v1/auth/email/verify",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ challengeId, code }),
        },
        decodeSessionResponse,
      );
      // Signing in as somebody else without signing out first. The host credentials belong
      // to the account that was issued them, and must not be filed under this session.
      if (this.#sessionAccountId !== null && this.#sessionAccountId !== session.user.id) {
        this.#teamHostTokens.clear();
      }
      this.#sessionToken = session.sessionToken;
      await this.#writeStoredSession();
      return this.#setState({
        status: "signed_in",
        user: this.#resolveUserAvatar(session.user),
      });
    } catch (error) {
      await this.#clearStoredSession();
      if (challenge) {
        return this.#setState({
          ...challenge,
          issue: centralAuthIssue(error, "email_sign_in_failed", "The sign-in code could not be verified."),
        });
      }
      return this.#setState({
        status: "error",
        issue: centralAuthIssue(error, "email_sign_in_failed", "The sign-in code could not be verified."),
      });
    }
  }

  async logout(): Promise<CentralAuthState> {
    this.#emailCodeRequest = null;
    if (this.#sessionToken) {
      try {
        await this.#authorizedRequest("/v1/auth/logout", { method: "POST" }, decodeVoid);
      } catch {
        // Local logout must still remove the session from this device.
      }
    }
    await this.#clearStoredSession();
    return this.#setState({ status: "signed_out" });
  }

  async updateAvatar(image: AvatarImageInput | null): Promise<CentralAuthState> {
    const sessionToken = this.#sessionToken;
    if (!sessionToken) throw new AuthApiError(401, "unauthorized", "Sign in is required.");
    const user = image
      ? await this.#authorizedRequest(
          "/v1/me/avatar",
          {
            method: "PUT",
            headers: { "Content-Type": image.mimeType },
            body: Buffer.from(image.bytes),
          },
          decodeCentralAuthUser,
        )
      : await this.#authorizedRequest(
          "/v1/me/avatar",
          {
            method: "DELETE",
          },
          decodeCentralAuthUser,
        );
    if (this.#sessionToken !== sessionToken || this.#state.status !== "signed_in") return this.getState();
    const resolvedUser = this.#resolveUserAvatar(user);
    return this.#setState({
      status: "signed_in",
      user: { ...this.#state.user, avatarUrl: resolvedUser.avatarUrl },
    });
  }

  async updateName(name: string): Promise<CentralAuthState> {
    const sessionToken = this.#sessionToken;
    if (!sessionToken) throw new AuthApiError(401, "unauthorized", "Sign in is required.");
    const user = await this.#authorizedRequest(
      "/v1/me/profile",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      },
      decodeCentralAuthUser,
    );
    if (this.#sessionToken !== sessionToken || this.#state.status !== "signed_in") return this.getState();
    return this.#setState({
      status: "signed_in",
      user: { ...this.#state.user, name: user.name },
    });
  }

  async #request<T>(path: string, init: RequestInit, decoder: (value: unknown) => T, timeoutMs = 10_000): Promise<T> {
    const response = await this.#options.fetch(new URL(path, this.#options.apiUrl), {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw await AuthApiError.fromResponse(response);
    return decoder(response.status === 204 ? undefined : await response.json());
  }

  async #startupRequest<T>(
    path: string,
    init: RequestInit,
    decoder: (value: unknown) => T,
    sessionToken?: string,
  ): Promise<T> {
    const deadline = Date.now() + this.#options.startupRetryWindowMs;
    let retryIndex = 0;
    while (true) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new Error(AUTH_API_UNAVAILABLE_MESSAGE);
      try {
        return await this.#request(
          path,
          {
            ...init,
            headers: sessionToken ? { ...init.headers, Authorization: `Bearer ${sessionToken}` } : init.headers,
          },
          decoder,
          Math.max(1, Math.min(this.#options.startupRequestTimeoutMs, remainingMs)),
        );
      } catch (error) {
        if (!isTransientStartupError(error)) throw error;
        const delayMs = Math.min(
          this.#options.startupRetryDelaysMs[Math.min(retryIndex, this.#options.startupRetryDelaysMs.length - 1)],
          Math.max(0, deadline - Date.now()),
        );
        if (delayMs <= 0) throw error;
        await delay(delayMs);
        retryIndex += 1;
      }
    }
  }

  #authorizedRequest<T>(
    path: string,
    init: RequestInit,
    decoder: (value: unknown) => T,
    timeoutMs?: number,
  ): Promise<T> {
    if (!this.#sessionToken) throw new AuthApiError(401, "unauthorized", "Sign in is required.");
    return this.#request(
      path,
      {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${this.#sessionToken}` },
      },
      decoder,
      timeoutMs,
    );
  }

  #resolveUserAvatar(user: CentralAuthUser): CentralAuthUser {
    return {
      ...user,
      avatarUrl: user.avatarUrl ? new URL(user.avatarUrl, this.#options.apiUrl).toString() : null,
    };
  }

  #writeStoredSession(): Promise<void> {
    // Serialized: two writes racing inside their filesystem awaits would let the earlier
    // one rename its snapshot over the later one, restoring a session the user has left.
    this.#sessionWriteChain = this.#sessionWriteChain.then(
      () => this.#writeStoredSessionNow(),
      () => this.#writeStoredSessionNow(),
    );
    return this.#sessionWriteChain;
  }

  async #writeStoredSessionNow(): Promise<void> {
    if (!this.#sessionToken) return;
    if (!this.#options.canPersist()) {
      await rm(this.#options.storagePath, { force: true });
      return;
    }
    const temporaryPath = `${this.#options.storagePath}.${randomUUID()}.tmp`;
    try {
      const value = JSON.stringify({
        version: 2,
        sessionToken: this.#sessionToken,
        teamHostTokens: Object.fromEntries(this.#teamHostTokens),
      });
      const encrypted = this.#options.encrypt(value).toString("base64");
      await mkdir(dirname(this.#options.storagePath), { recursive: true });
      await writeFile(temporaryPath, encrypted, { mode: 0o600 });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.#options.storagePath);
    } catch {
      await Promise.allSettled([rm(this.#options.storagePath, { force: true }), rm(temporaryPath, { force: true })]);
    } finally {
      await Promise.allSettled([rm(temporaryPath, { force: true })]);
    }
  }

  async #clearStoredSession(): Promise<void> {
    this.#sessionToken = null;
    this.#sessionAccountId = null;
    this.#teamHostTokens.clear();
    // Through the same chain as the writes, so a write already in flight cannot put the
    // file back after it is removed.
    this.#sessionWriteChain = this.#sessionWriteChain.then(
      () => rm(this.#options.storagePath, { force: true }),
      () => rm(this.#options.storagePath, { force: true }),
    );
    await this.#sessionWriteChain;
  }

  #restoreStoredSession(value: string): void {
    if (!value.trimStart().startsWith("{")) {
      this.#sessionToken = value;
      this.#teamHostTokens.clear();
      return;
    }
    const stored = JSON.parse(value);
    if (!isDynamicRecord(stored) || stored.version !== 2 || !isString(stored.sessionToken)) {
      throw new Error("Invalid protected account session.");
    }
    this.#sessionToken = stored.sessionToken;
    this.#teamHostTokens.clear();
    if (isDynamicRecord(stored.teamHostTokens)) {
      for (const [serverId, token] of Object.entries(stored.teamHostTokens)) {
        if (/^[0-9a-f-]{36}$/iu.test(serverId) && isString(token) && /^[A-Za-z0-9_-]{32,128}$/u.test(token)) {
          this.#teamHostTokens.set(serverId.toLowerCase(), token);
        }
      }
    }
  }

  #setState(state: CentralAuthState): CentralAuthState {
    // Held apart from the state, which passes through `code_sent` on the way to another
    // account: this is whose credentials the store is holding, until they are cleared.
    if (state.status === "signed_in") this.#sessionAccountId = state.user.id;
    this.#state = state;
    const copy = this.getState();
    this.emit("changed", copy);
    return copy;
  }

  #setInitializationError(error: unknown): CentralAuthState {
    const apiError = error instanceof AuthApiError ? error : null;
    const unavailable = !apiError || apiError.status >= 500;
    return this.#setState({
      status: "error",
      issue: {
        code: unavailable ? "auth_api_unavailable" : apiError.code,
        message: unavailable ? AUTH_API_UNAVAILABLE_MESSAGE : apiError.message,
        ...(apiError?.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: apiError.retryAfterSeconds }),
      },
    });
  }
}

export function readCentralAuthApiUrl(value: string | undefined, fallback = "http://127.0.0.1:3100"): string {
  const url = new URL(value ?? fallback);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.pathname !== "/") {
    throw new Error("OPENBOT_AUTH_API_URL must be HTTPS or an HTTP loopback origin.");
  }
  return url.origin;
}

export function readMobileConnectApiUrl(value: string | undefined, fallback: string): string {
  const apiUrl = value ?? fallback;
  createMobileConnectUrl({ apiUrl, ticket: "x".repeat(32) });
  return new URL(apiUrl).origin;
}

class AuthApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }

  static async fromResponse(response: Response): Promise<AuthApiError> {
    const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get("Retry-After"));
    try {
      const value = await response.json();
      if (!isDynamicRecord(value) || !isDynamicRecord(value.error)) {
        throw new Error("Invalid error response.");
      }
      if (isString(value.error.code) && isString(value.error.message)) {
        return new AuthApiError(response.status, value.error.code, value.error.message, retryAfterSeconds);
      }
    } catch {
      // Use a generic error when the server did not return the API error shape.
    }
    return new AuthApiError(
      response.status,
      "auth_api_error",
      "The account service returned an error.",
      retryAfterSeconds,
    );
  }
}

function centralAuthIssue(error: unknown, fallbackCode: string, fallbackMessage: string): CentralAuthIssue {
  if (error instanceof AuthApiError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }),
    };
  }
  return { code: fallbackCode, message: errorMessage(error, fallbackMessage) };
}

function emailCodeRequestIssue(error: unknown): CentralAuthIssue {
  if (error instanceof AuthApiError) {
    return centralAuthIssue(error, "email_sign_in_start_failed", "OpenBot could not send the sign-in code.");
  }
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return {
      code: "email_delivery_timeout",
      message:
        "OpenBot could not confirm delivery in time. The code may still arrive; check delivery before sending again.",
    };
  }
  if (error instanceof TypeError || (error instanceof DOMException && error.name === "AbortError")) {
    return {
      code: "email_delivery_unknown",
      message: "The connection ended before OpenBot confirmed delivery. Check delivery to avoid sending another code.",
    };
  }
  return {
    code: "email_delivery_unknown",
    message: "OpenBot could not confirm whether the sign-in code was sent. Check delivery before sending again.",
  };
}

function isDefinitiveEmailCodeRequestFailure(error: unknown): boolean {
  if (!(error instanceof AuthApiError)) return false;
  return DEFINITIVE_EMAIL_CODE_REQUEST_FAILURES.has(error.code);
}

function parseRetryAfterSeconds(value: string | null): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/u.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    return seconds > 0 ? seconds : undefined;
  }
  const retryAt = Date.parse(trimmed);
  if (!Number.isFinite(retryAt)) return undefined;
  const seconds = Math.ceil((retryAt - Date.now()) / 1_000);
  return seconds > 0 ? seconds : undefined;
}

function decodeRecord(value: unknown, label: string): DynamicRecord {
  if (!isDynamicRecord(value)) throw new Error(`Invalid ${label}.`);
  return value;
}

function requiredString(record: DynamicRecord, field: string): string {
  const value = record[field];
  if (!isString(value)) throw new Error(`Invalid ${field}.`);
  return value;
}

function decodeVoid(value: unknown): undefined {
  if (value !== undefined && value !== null) throw new Error("The account service returned data.");
  return undefined;
}

function decodeRecordHealth(value: unknown): DynamicRecord {
  return decodeRecord(value, "health response");
}

function decodeCentralAuthUser(value: unknown): CentralAuthUser {
  const record = decodeRecord(value, "account user");
  const name = record.name;
  const avatarUrl = record.avatarUrl;
  if (name !== null && !isString(name)) throw new Error("Invalid account name.");
  if (avatarUrl !== null && !isString(avatarUrl)) throw new Error("Invalid account avatar.");
  return {
    id: requiredString(record, "id"),
    email: requiredString(record, "email"),
    name,
    avatarUrl,
  };
}

function decodeTicketResponse(value: unknown): { ticket: string; expiresAt: number } {
  const record = decodeRecord(value, "team ticket");
  if (!isNumber(record.expiresAt)) throw new Error("Invalid team ticket expiration.");
  return { ticket: requiredString(record, "ticket"), expiresAt: record.expiresAt };
}

function decodeMobileConnectedDevices(value: unknown): { devices: MobileConnectedDevice[] } {
  const record = decodeRecord(value, "mobile devices");
  if (!Array.isArray(record.devices)) throw new Error("Invalid mobile device list.");
  return { devices: record.devices.map(decodeMobileConnectedDevice) };
}

function decodeMobileConnectedDevice(value: unknown): MobileConnectedDevice {
  const record = decodeRecord(value, "mobile device");
  if (!isNumber(record.connectedAt) || !isNumber(record.lastActiveAt)) {
    throw new Error("Invalid mobile device timestamps.");
  }
  const platform = record.platform;
  if (platform !== "ios" && platform !== "android" && platform !== "unknown") {
    throw new Error("Invalid mobile device platform.");
  }
  return {
    sessionId: requiredString(record, "sessionId"),
    name: requiredString(record, "name"),
    platform,
    connectedAt: record.connectedAt,
    lastActiveAt: record.lastActiveAt,
  };
}

function decodeRegisteredRemoteHost(value: unknown): RegisteredRemoteHost {
  const record = decodeRecord(value, "remote host registration");
  if (!isNumber(record.authEpoch) || !Number.isSafeInteger(record.authEpoch) || record.authEpoch < 1) {
    throw new Error("Invalid remote host auth epoch.");
  }
  return {
    hostId: requiredString(record, "hostId"),
    name: requiredString(record, "name"),
    membershipId: requiredString(record, "membershipId"),
    authEpoch: record.authEpoch,
    machineToken: record.machineToken === null ? null : requiredString(record, "machineToken"),
  };
}

function decodeRemoteConnectionBootstrap(value: unknown): RemoteConnectionBootstrap {
  const record = decodeRecord(value, "remote connection bootstrap");
  if (!isNumber(record.expiresAt)) throw new Error("Invalid remote ticket expiration.");
  const signalUrl = requiredString(record, "signalUrl");
  const signal = new URL(signalUrl);
  if (signal.protocol !== "wss:" && !(signal.protocol === "ws:" && isMobileConnectDevelopmentHost(signal.hostname)))
    throw new Error("Invalid Remote Signal URL.");
  return { ticket: requiredString(record, "ticket"), expiresAt: record.expiresAt, signalUrl };
}

function decodeRemoteSession(value: unknown): { sessionId: string; hostId: string; expiresAt: number } {
  const record = decodeRecord(value, "remote session");
  if (!isNumber(record.expiresAt)) throw new Error("Invalid remote session expiration.");
  return {
    sessionId: requiredString(record, "sessionId"),
    hostId: requiredString(record, "hostId"),
    expiresAt: record.expiresAt,
  };
}

function decodeRemoteHosts(value: unknown): RemoteHostSummary[] {
  const record = decodeRecord(value, "remote hosts");
  if (!Array.isArray(record.hosts)) throw new Error("Invalid remote host list.");
  return record.hosts.map((item) => {
    const host = decodeRecord(item, "remote host");
    if (!isNumber(host.authEpoch) || !Number.isSafeInteger(host.authEpoch) || host.authEpoch < 1)
      throw new Error("Invalid remote auth epoch.");
    if (host.logoKey !== null && !isString(host.logoKey)) throw new Error("Invalid remote host logo.");
    if (host.devicePublicKey !== null && !isString(host.devicePublicKey)) throw new Error("Invalid remote host key.");
    if (host.role !== "owner" && host.role !== "admin" && host.role !== "member")
      throw new Error("Invalid remote host role.");
    return {
      hostId: requiredString(host, "hostId"),
      name: requiredString(host, "name"),
      logoKey: host.logoKey,
      devicePublicKey: host.devicePublicKey,
      authEpoch: host.authEpoch,
      membershipId: requiredString(host, "membershipId"),
      role: host.role,
    };
  });
}

function decodeCreatedRemoteInvite(value: unknown): { inviteId: string; token: string; expiresAt: number } {
  const record = decodeRecord(value, "remote invitation");
  if (!isNumber(record.expiresAt)) throw new Error("Invalid remote invitation expiration.");
  return {
    inviteId: requiredString(record, "inviteId"),
    token: requiredString(record, "token"),
    expiresAt: record.expiresAt,
  };
}

function decodeRemoteInvite(value: unknown): RemoteInviteRecord {
  const record = decodeRecord(value, "remote invitation");
  if (record.role !== "admin" && record.role !== "member") throw new Error("Invalid remote invitation role.");
  if (!isNumber(record.expiresAt)) throw new Error("Invalid remote invitation expiration.");
  if (record.usedAt !== null && !isNumber(record.usedAt)) throw new Error("Invalid remote invitation use time.");
  if (record.revokedAt !== null && !isNumber(record.revokedAt))
    throw new Error("Invalid remote invitation revocation time.");
  if (record.email !== null && !isString(record.email)) throw new Error("Invalid remote invitation email.");
  return {
    inviteId: requiredString(record, "inviteId"),
    email: record.email,
    role: record.role,
    expiresAt: record.expiresAt,
    usedAt: record.usedAt,
    revokedAt: record.revokedAt,
  };
}

function decodeRemoteInvites(value: unknown): RemoteInviteRecord[] {
  const record = decodeRecord(value, "remote invitation list");
  if (!Array.isArray(record.invites)) throw new Error("Invalid remote invitation list.");
  return record.invites.map(decodeRemoteInvite);
}

function decodeRemoteInvitePreview(value: unknown): RemoteInvitePreview {
  const record = decodeRecord(value, "remote invitation preview");
  if (record.role !== "admin" && record.role !== "member") throw new Error("Invalid remote invitation role.");
  if (!isNumber(record.expiresAt) || !isBoolean(record.emailBound))
    throw new Error("Invalid remote invitation preview.");
  if (record.devicePublicKey !== null && !isString(record.devicePublicKey))
    throw new Error("Invalid remote invitation host key.");
  return {
    inviteId: requiredString(record, "inviteId"),
    hostId: requiredString(record, "hostId"),
    hostName: requiredString(record, "hostName"),
    role: record.role,
    expiresAt: record.expiresAt,
    emailBound: record.emailBound,
    devicePublicKey: record.devicePublicKey,
  };
}

function decodeAcceptedRemoteInvite(value: unknown): {
  hostId: string;
  membershipId: string;
  role: "admin" | "member";
} {
  const record = decodeRecord(value, "accepted remote invitation");
  if (record.role !== "admin" && record.role !== "member") throw new Error("Invalid remote membership role.");
  return {
    hostId: requiredString(record, "hostId"),
    membershipId: requiredString(record, "membershipId"),
    role: record.role,
  };
}

function decodeRemoteMember(value: unknown): RemoteMemberRecord {
  const record = decodeRecord(value, "remote member");
  if (record.role !== "owner" && record.role !== "admin" && record.role !== "member")
    throw new Error("Invalid remote member role.");
  if (record.status !== "active" && record.status !== "revoked") throw new Error("Invalid remote member status.");
  if (!isNumber(record.createdAt)) throw new Error("Invalid remote member creation time.");
  if (record.name !== null && !isString(record.name)) throw new Error("Invalid remote member name.");
  if (record.avatarUrl !== null && !isString(record.avatarUrl)) throw new Error("Invalid remote member avatar.");
  return {
    membershipId: requiredString(record, "membershipId"),
    email: requiredString(record, "email"),
    name: record.name,
    avatarUrl: record.avatarUrl,
    role: record.role,
    status: record.status,
    createdAt: record.createdAt,
  };
}

function decodeRemoteMembers(value: unknown): RemoteMemberRecord[] {
  const record = decodeRecord(value, "remote member list");
  if (!Array.isArray(record.members)) throw new Error("Invalid remote member list.");
  return record.members.map(decodeRemoteMember);
}

function decodeEmailChallenge(value: unknown): {
  challengeId: string;
  expiresAt: number;
  resendAt?: number;
  developmentCode?: string;
} {
  const record = decodeRecord(value, "email challenge");
  if (!isNumber(record.expiresAt)) throw new Error("Invalid email challenge expiration.");
  const developmentCode = record.developmentCode;
  const resendAt = record.resendAt;
  if (developmentCode !== undefined && !isString(developmentCode)) {
    throw new Error("Invalid development code.");
  }
  if (resendAt !== undefined && !isNumber(resendAt)) throw new Error("Invalid email resend time.");
  return {
    challengeId: requiredString(record, "challengeId"),
    expiresAt: record.expiresAt,
    ...(resendAt === undefined ? {} : { resendAt }),
    ...(developmentCode === undefined ? {} : { developmentCode }),
  };
}

function decodeSessionResponse(value: unknown): SessionResponse {
  const record = decodeRecord(value, "session");
  return {
    sessionToken: requiredString(record, "sessionToken"),
    user: decodeCentralAuthUser(record.user),
  };
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function isTransientStartupError(error: unknown): boolean {
  return !(error instanceof AuthApiError) || error.status >= 500;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
