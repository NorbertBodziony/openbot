import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AvatarImageInput, CentralAuthState, CentralAuthUser } from "@openbot/contracts/ipc";
import { isString } from "@openbot/contracts/runtime-values";
import { isOpenBotTeamApiHostname, isOpenBotTeamVncHostname } from "@openbot/contracts/validation";

interface CentralAuthEvents {
  changed: [state: CentralAuthState];
}

interface CentralAuthManagerOptions {
  apiUrl: string;
  storagePath: string;
  encrypt: (value: string) => Buffer;
  decrypt: (value: Buffer) => string;
  fetch?: typeof fetch;
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
    const result = await this.#authorizedRequest<{ ticket: string; expiresAt: number }>(
      "/v1/team-auth/ticket",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId }),
      },
    );
    if (!result.ticket || !Number.isFinite(result.expiresAt)) {
      throw new Error("The account service returned an invalid team ticket.");
    }
    return result.ticket;
  }

  async redeemTeamAuthTicket(ticket: string, serverId: string): Promise<CentralAuthUser | null> {
    if (!ticket) return null;
    try {
      const user = await this.#request<CentralAuthUser>("/v1/team-auth/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket, serverId }),
      });
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
    return this.#authorizedRequest("/v1/team-invitations/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  async provisionTeamTunnel(input: {
    serverId: string;
    serverName: string;
    apiPort?: number | null;
    vncEnabled?: boolean;
  }): Promise<ProvisionedTeamTunnel> {
    const result = await this.#authorizedRequest<ProvisionedTeamTunnel>(
      "/v1/team-tunnels/provision",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
      60_000,
    );
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        result.tunnelId,
      ) ||
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
      await this.#startupRequest("/health/live", { method: "GET" });
      return this.#setState({ status: "signed_out" });
    }
    try {
      const user = await this.#startupRequest<CentralAuthUser>(
        "/v1/me",
        { method: "GET" },
        this.#sessionToken,
      );
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
    this.#setState({ status: "signing_in" });
    try {
      const result = await this.#request<{
        challengeId: string;
        expiresAt: number;
        developmentCode?: string;
      }>("/v1/auth/email/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!result.challengeId || !Number.isFinite(result.expiresAt)) {
        throw new Error("The account service returned an invalid sign-in challenge.");
      }
      return this.#setState({
        status: "code_sent",
        challengeId: result.challengeId,
        email: email.trim().toLowerCase(),
        expiresAt: result.expiresAt,
        ...(result.developmentCode ? { developmentCode: result.developmentCode } : {}),
      });
    } catch (error) {
      return this.#setState({
        status: "error",
        code: error instanceof AuthApiError ? error.code : "email_sign_in_start_failed",
        message: errorMessage(error, "OpenBot could not send the sign-in code."),
      });
    }
  }

  async verifyEmailCode(challengeId: string, code: string): Promise<CentralAuthState> {
    const challenge = this.#state.status === "code_sent" ? this.#state : null;
    try {
      const session = await this.#request<SessionResponse>("/v1/auth/email/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId, code }),
      });
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
          error: errorMessage(error, "The sign-in code could not be verified."),
        });
      }
      return this.#setState({
        status: "error",
        code: error instanceof AuthApiError ? error.code : "email_sign_in_failed",
        message: errorMessage(error, "The sign-in code could not be verified."),
      });
    }
  }

  async logout(): Promise<CentralAuthState> {
    if (this.#sessionToken) {
      try {
        await this.#authorizedRequest("/v1/auth/logout", { method: "POST" });
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
      ? await this.#authorizedRequest<CentralAuthUser>("/v1/me/avatar", {
          method: "PUT",
          headers: { "Content-Type": image.mimeType },
          body: Buffer.from(image.bytes),
        })
      : await this.#authorizedRequest<CentralAuthUser>("/v1/me/avatar", {
          method: "DELETE",
        });
    if (this.#sessionToken !== sessionToken) return this.getState();
    return this.#setState({ status: "signed_in", user: this.#resolveUserAvatar(user) });
  }

  async #request<T>(path: string, init: RequestInit, timeoutMs = 10_000): Promise<T> {
    const response = await this.#options.fetch(new URL(path, this.#options.apiUrl), {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw await AuthApiError.fromResponse(response);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async #startupRequest<T>(path: string, init: RequestInit, sessionToken?: string): Promise<T> {
    const deadline = Date.now() + this.#options.startupRetryWindowMs;
    let retryIndex = 0;
    while (true) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new Error(AUTH_API_UNAVAILABLE_MESSAGE);
      try {
        return await this.#request<T>(
          path,
          {
            ...init,
            headers: sessionToken
              ? { ...init.headers, Authorization: `Bearer ${sessionToken}` }
              : init.headers,
          },
          Math.max(1, Math.min(this.#options.startupRequestTimeoutMs, remainingMs)),
        );
      } catch (error) {
        if (!isTransientStartupError(error)) throw error;
        const delayMs = Math.min(
          this.#options.startupRetryDelaysMs[
            Math.min(retryIndex, this.#options.startupRetryDelaysMs.length - 1)
          ],
          Math.max(0, deadline - Date.now()),
        );
        if (delayMs <= 0) throw error;
        await delay(delayMs);
        retryIndex += 1;
      }
    }
  }

  #authorizedRequest<T>(path: string, init: RequestInit, timeoutMs?: number): Promise<T> {
    if (!this.#sessionToken) throw new AuthApiError(401, "unauthorized", "Sign in is required.");
    return this.#request<T>(
      path,
      {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${this.#sessionToken}` },
      },
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
      code: unavailable ? "auth_api_unavailable" : apiError.code,
      message: unavailable ? AUTH_API_UNAVAILABLE_MESSAGE : apiError.message,
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

export function readCentralAuthApiUrl(value: string | undefined): string {
  const url = new URL(value ?? "http://127.0.0.1:3100");
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.pathname !== "/"
  ) {
    throw new Error("OPENBOT_AUTH_API_URL must be HTTPS or an HTTP loopback origin.");
  }
  return url.origin;
}

class AuthApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }

  static async fromResponse(response: Response): Promise<AuthApiError> {
    try {
      const value = (await response.json()) as { error?: { code?: unknown; message?: unknown } };
      if (isString(value.error?.code) && isString(value.error.message)) {
        return new AuthApiError(response.status, value.error.code, value.error.message);
      }
    } catch {
      // Use a generic error when the server did not return the API error shape.
    }
    return new AuthApiError(
      response.status,
      "auth_api_error",
      "The account service returned an error.",
    );
  }
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
