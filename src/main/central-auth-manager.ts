import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AvatarImageInput, CentralAuthIssue, CentralAuthState, CentralAuthUser } from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import { isOpenBotTeamApiHostname, isOpenBotTeamVncHostname } from "@openbot/contracts/validation";

interface CentralAuthEvents {
  changed: [state: CentralAuthState];
}

type AuthFetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface CentralAuthManagerOptions {
  apiUrl: string;
  storagePath: string;
  encrypt: (value: string) => Buffer;
  decrypt: (value: Buffer) => string;
  fetch?: AuthFetcher;
  startupRetryWindowMs?: number;
  startupRequestTimeoutMs?: number;
  startupRetryDelaysMs?: readonly number[];
}

interface SessionResponse {
  sessionToken: string;
  user: CentralAuthUser;
}

const STARTUP_RETRY_WINDOW_MS = 30_000;
const STARTUP_REQUEST_TIMEOUT_MS = 3_000;
const STARTUP_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000] as const;
const RESEND_FALLBACK_DELAY_MS = 60_000;
const AUTH_API_UNAVAILABLE_MESSAGE =
  "OpenBot could not reach the account service. Check that the API is running, then try again.";

export interface ProvisionedTeamTunnel {
  tunnelId: string;
  tunnelName: string;
  apiUrl: string;
  vncHostname: string;
  token: string;
}

export class CentralAuthManager extends EventEmitter<CentralAuthEvents> {
  readonly #options: Required<CentralAuthManagerOptions>;
  #state: CentralAuthState = { status: "loading" };
  #sessionToken: string | null = null;
  #initializationPromise: Promise<CentralAuthState> | null = null;

  constructor(options: CentralAuthManagerOptions) {
    super();
    this.#options = {
      ...options,
      fetch: options.fetch ?? fetch,
      startupRetryWindowMs: options.startupRetryWindowMs ?? STARTUP_RETRY_WINDOW_MS,
      startupRequestTimeoutMs: options.startupRequestTimeoutMs ?? STARTUP_REQUEST_TIMEOUT_MS,
      startupRetryDelaysMs: options.startupRetryDelaysMs ?? STARTUP_RETRY_DELAYS_MS,
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

  async provisionTeamTunnel(input: {
    serverId: string;
    serverName: string;
    apiPort?: number | null;
    vncEnabled?: boolean;
  }): Promise<ProvisionedTeamTunnel> {
    const result = await this.#authorizedRequest(
      "/v1/team-tunnels/provision",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
      decodeProvisionedTeamTunnel,
      60_000,
    );
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(result.tunnelId) ||
      !/^openbot-[0-9a-f]{32}$/u.test(result.tunnelName) ||
      !isOpenBotHostUrl(result.apiUrl) ||
      !isOpenBotTeamVncHostname(result.vncHostname) ||
      result.token.length < 40
    ) {
      throw new Error("The account service returned invalid team tunnel details.");
    }
    return result;
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
    try {
      const encrypted = Buffer.from(await readFile(this.#options.storagePath, "utf8"), "base64");
      this.#sessionToken = this.#options.decrypt(encrypted);
    } catch (error) {
      if (!isMissing(error)) {
        await this.#clearStoredSession();
      }
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

  async requestEmailCode(email: string): Promise<CentralAuthState> {
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
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        },
        decodeEmailChallenge,
      );
      if (!result.challengeId || !Number.isFinite(result.expiresAt)) {
        throw new Error("The account service returned an invalid sign-in challenge.");
      }
      return this.#setState({
        status: "code_sent",
        challengeId: result.challengeId,
        email: email.trim().toLowerCase(),
        expiresAt: result.expiresAt,
        resendAvailableAt: result.resendAt ?? Math.min(result.expiresAt, Date.now() + RESEND_FALLBACK_DELAY_MS),
        ...(result.developmentCode ? { developmentCode: result.developmentCode } : {}),
      });
    } catch (error) {
      const issue = centralAuthIssue(error, "email_sign_in_start_failed", "OpenBot could not send the sign-in code.");
      if (existingChallenge) {
        return this.#setState({ ...existingChallenge, issue });
      }
      return this.#setState({
        status: "error",
        issue,
      });
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
      this.#sessionToken = session.sessionToken;
      await this.#writeStoredSession(session.sessionToken);
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
    if (this.#sessionToken !== sessionToken) return this.getState();
    return this.#setState({ status: "signed_in", user: this.#resolveUserAvatar(user) });
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

  async #writeStoredSession(token: string): Promise<void> {
    const encrypted = this.#options.encrypt(token).toString("base64");
    const temporaryPath = `${this.#options.storagePath}.${randomUUID()}.tmp`;
    await mkdir(dirname(this.#options.storagePath), { recursive: true });
    try {
      await writeFile(temporaryPath, encrypted, { mode: 0o600 });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.#options.storagePath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  async #clearStoredSession(): Promise<void> {
    this.#sessionToken = null;
    await rm(this.#options.storagePath, { force: true });
  }

  #setState(state: CentralAuthState): CentralAuthState {
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

function isOpenBotHostUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      isOpenBotTeamApiHostname(url.hostname)
    );
  } catch {
    return false;
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

function decodeProvisionedTeamTunnel(value: unknown): ProvisionedTeamTunnel {
  const record = decodeRecord(value, "team tunnel");
  return {
    tunnelId: requiredString(record, "tunnelId"),
    tunnelName: requiredString(record, "tunnelName"),
    apiUrl: requiredString(record, "apiUrl"),
    vncHostname: requiredString(record, "vncHostname"),
    token: requiredString(record, "token"),
  };
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
