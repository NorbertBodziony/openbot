import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CentralAuthState, CentralAuthUser } from "../shared/ipc";

interface CentralAuthEvents {
  changed: [state: CentralAuthState];
}

interface CentralAuthManagerOptions {
  apiUrl: string;
  storagePath: string;
  encrypt: (value: string) => Buffer;
  decrypt: (value: Buffer) => string;
  fetch?: typeof fetch;
}

interface SessionResponse {
  sessionToken: string;
  user: CentralAuthUser;
}

export class CentralAuthManager extends EventEmitter<CentralAuthEvents> {
  readonly #options: Required<CentralAuthManagerOptions>;
  #state: CentralAuthState = { status: "loading" };
  #sessionToken: string | null = null;

  constructor(options: CentralAuthManagerOptions) {
    super();
    this.#options = { ...options, fetch: options.fetch ?? fetch };
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
      return await this.#request<CentralAuthUser>("/v1/team-auth/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket, serverId }),
      });
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

  async initialize(): Promise<CentralAuthState> {
    try {
      const encrypted = Buffer.from(await readFile(this.#options.storagePath, "utf8"), "base64");
      this.#sessionToken = this.#options.decrypt(encrypted);
    } catch (error) {
      if (!isMissing(error)) {
        await this.#clearStoredSession();
      }
      return this.#setState({ status: "signed_out" });
    }
    try {
      const user = await this.#authorizedRequest<CentralAuthUser>("/v1/me", { method: "GET" });
      return this.#setState({ status: "signed_in", user });
    } catch (error) {
      if (error instanceof AuthApiError && error.status === 401) {
        await this.#clearStoredSession();
        return this.#setState({ status: "signed_out" });
      }
      return this.#setState({
        status: "error",
        code: "auth_api_unavailable",
        message: errorMessage(error, "OpenBot could not reach the account service."),
      });
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
      return this.#setState({ status: "signed_in", user: session.user });
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

  async #request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.#options.fetch(new URL(path, this.#options.apiUrl), {
      ...init,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw await AuthApiError.fromResponse(response);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  #authorizedRequest<T>(path: string, init: RequestInit): Promise<T> {
    if (!this.#sessionToken) throw new AuthApiError(401, "unauthorized", "Sign in is required.");
    return this.#request<T>(path, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${this.#sessionToken}` },
    });
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
      if (typeof value.error?.code === "string" && typeof value.error.message === "string") {
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
