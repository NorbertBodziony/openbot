import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  sign,
  timingSafeEqual,
} from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import type {
  TeamInviteSummary,
  TeamMemberSummary,
  TeamRole,
  TeamSessionSummary,
} from "../shared/ipc";

const scrypt = promisify(scryptCallback);
const INVITE_TTL_MS = 24 * 60 * 60 * 1_000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

interface StoredMember extends TeamMemberSummary {
  passwordSalt: string;
  passwordHash: string;
}

interface StoredInvite {
  id: string;
  tokenHash: string;
  role: Exclude<TeamRole, "owner">;
  expiresAt: string;
  usedAt: string | null;
}

interface StoredSession {
  id: string;
  memberId: string;
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
}

interface StoredTeam {
  version: 1;
  serverId: string;
  serverName: string;
  enabledOnLaunch: boolean;
  publicKey: string;
  privateKey: string;
  members: StoredMember[];
  invites: StoredInvite[];
  sessions: StoredSession[];
}

export interface TeamIdentity {
  serverId: string;
  serverName: string;
  fingerprint: string;
  publicKey: string;
  enabledOnLaunch: boolean;
}

export interface CreatedInvite {
  id: string;
  role: Exclude<TeamRole, "owner">;
  token: string;
  expiresAt: string;
}

export interface AddressUpdateProof {
  serverId: string;
  apiUrl: string;
  vncHostname: string | null;
  publicKey: string;
  signature: string;
}

export interface AuthenticatedMember {
  member: TeamMemberSummary;
  sessionToken: string;
  sessionExpiresAt: string;
}

export class TeamStore {
  readonly #path: string;
  #state: StoredTeam | null = null;
  #writeChain = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  async initialize(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.#path, "utf8")) as StoredTeam;
      this.#state = isStoredTeam(parsed) ? parsed : null;
      if (this.#state) await this.#prune();
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }

  get configured(): boolean {
    return this.#state !== null;
  }

  getIdentity(): TeamIdentity | null {
    if (!this.#state) return null;
    return {
      serverId: this.#state.serverId,
      serverName: this.#state.serverName,
      fingerprint: fingerprint(this.#state.publicKey),
      publicKey: this.#state.publicKey,
      enabledOnLaunch: this.#state.enabledOnLaunch,
    };
  }

  getIdentityProof(
    challenge: string,
  ): (TeamIdentity & { challenge: string; signature: string }) | null {
    const identity = this.getIdentity();
    if (!identity || !this.#state || !/^[A-Za-z0-9_-]{16,128}$/.test(challenge)) return null;
    const signature = sign(null, Buffer.from(challenge), this.#state.privateKey).toString(
      "base64url",
    );
    return { ...identity, challenge, signature };
  }

  async configure(serverName: string, username: string, password: string): Promise<TeamIdentity> {
    if (this.#state) throw new Error("The team server is already configured.");
    validateServerName(serverName);
    validateUsername(username);
    validatePassword(password);
    const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const credentials = await hashPassword(password);
    this.#state = {
      version: 1,
      serverId: randomUUID(),
      serverName: serverName.trim(),
      enabledOnLaunch: false,
      publicKey,
      privateKey,
      members: [
        {
          id: randomUUID(),
          username: username.trim().toLowerCase(),
          role: "owner",
          disabled: false,
          createdAt: new Date().toISOString(),
          ...credentials,
        },
      ],
      invites: [],
      sessions: [],
    };
    await this.#persist();
    return this.getIdentity() as TeamIdentity;
  }

  async setEnabledOnLaunch(enabled: boolean): Promise<void> {
    const state = this.#requireState();
    state.enabledOnLaunch = enabled;
    await this.#persist();
  }

  listMembers(): TeamMemberSummary[] {
    return this.#requireState().members.map(publicMember);
  }

  listInvites(): TeamInviteSummary[] {
    return this.#requireState().invites.map((invite) => ({
      id: invite.id,
      role: invite.role,
      expiresAt: invite.expiresAt,
      usedAt: invite.usedAt,
    }));
  }

  listSessions(): TeamSessionSummary[] {
    const state = this.#requireState();
    return state.sessions.map((session) => ({
      id: session.id,
      memberId: session.memberId,
      username:
        state.members.find((member) => member.id === session.memberId)?.username ?? "unknown",
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
    }));
  }

  createAddressUpdateProof(apiUrl: string, vncHostname: string | null): AddressUpdateProof {
    const state = this.#requireState();
    const payload = addressUpdatePayload(state.serverId, apiUrl, vncHostname);
    return {
      serverId: state.serverId,
      apiUrl,
      vncHostname,
      publicKey: state.publicKey,
      signature: sign(null, Buffer.from(payload), state.privateKey).toString("base64url"),
    };
  }

  async createInvite(role: Exclude<TeamRole, "owner">): Promise<CreatedInvite> {
    if (role !== "admin" && role !== "member") throw new Error("Invalid invite role.");
    const state = this.#requireState();
    const token = randomBytes(32).toString("base64url");
    const invite: StoredInvite = {
      id: randomUUID(),
      tokenHash: hashToken(token),
      role,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
      usedAt: null,
    };
    state.invites.push(invite);
    await this.#persist();
    return { id: invite.id, role, token, expiresAt: invite.expiresAt };
  }

  async acceptInvite(
    token: string,
    username: string,
    password: string,
  ): Promise<AuthenticatedMember> {
    validateUsername(username);
    validatePassword(password);
    const state = this.#requireState();
    const normalizedUsername = username.trim().toLowerCase();
    if (state.members.some((member) => member.username === normalizedUsername)) {
      throw new Error("This username is already in use.");
    }
    const invite = state.invites.find(
      (candidate) =>
        candidate.usedAt === null &&
        Date.parse(candidate.expiresAt) > Date.now() &&
        safeTextEqual(candidate.tokenHash, hashToken(token)),
    );
    if (!invite) throw new Error("The invitation is invalid or expired.");
    const credentials = await hashPassword(password);
    const member: StoredMember = {
      id: randomUUID(),
      username: normalizedUsername,
      role: invite.role,
      disabled: false,
      createdAt: new Date().toISOString(),
      ...credentials,
    };
    invite.usedAt = new Date().toISOString();
    state.members.push(member);
    const result = this.#createSession(member);
    await this.#persist();
    return result;
  }

  async login(username: string, password: string): Promise<AuthenticatedMember> {
    const state = this.#requireState();
    const member = state.members.find(
      (candidate) => candidate.username === username.trim().toLowerCase() && !candidate.disabled,
    );
    if (!member || !(await verifyPassword(password, member))) {
      throw new Error("The username or password is incorrect.");
    }
    const result = this.#createSession(member);
    await this.#persist();
    return result;
  }

  authenticate(token: string): TeamMemberSummary | null {
    if (!this.#state || !token) return null;
    const tokenHash = hashToken(token);
    const session = this.#state.sessions.find(
      (candidate) =>
        Date.parse(candidate.expiresAt) > Date.now() &&
        safeTextEqual(candidate.tokenHash, tokenHash),
    );
    if (!session) return null;
    const member = this.#state.members.find(
      (candidate) => candidate.id === session.memberId && !candidate.disabled,
    );
    return member ? publicMember(member) : null;
  }

  async logout(token: string): Promise<void> {
    const state = this.#requireState();
    const tokenHash = hashToken(token);
    state.sessions = state.sessions.filter(
      (candidate) => !safeTextEqual(candidate.tokenHash, tokenHash),
    );
    await this.#persist();
  }

  async changePassword(memberId: string, currentPassword: string, nextPassword: string) {
    validatePassword(nextPassword);
    const state = this.#requireState();
    const member = state.members.find((candidate) => candidate.id === memberId);
    if (!member || !(await verifyPassword(currentPassword, member))) {
      throw new Error("The current password is incorrect.");
    }
    Object.assign(member, await hashPassword(nextPassword));
    state.sessions = state.sessions.filter((session) => session.memberId !== memberId);
    await this.#persist();
  }

  async updateMember(
    memberId: string,
    patch: { role?: Exclude<TeamRole, "owner">; disabled?: boolean },
  ): Promise<TeamMemberSummary> {
    const state = this.#requireState();
    const member = state.members.find((candidate) => candidate.id === memberId);
    if (!member) throw new Error("Team member not found.");
    if (member.role === "owner") throw new Error("The owner account cannot be changed.");
    if (patch.role !== undefined) {
      if (patch.role !== "admin" && patch.role !== "member") throw new Error("Invalid role.");
      member.role = patch.role;
    }
    if (patch.disabled !== undefined) member.disabled = patch.disabled;
    if (member.disabled) {
      state.sessions = state.sessions.filter((session) => session.memberId !== member.id);
    }
    await this.#persist();
    return publicMember(member);
  }

  async revokeSession(sessionId: string): Promise<void> {
    const state = this.#requireState();
    state.sessions = state.sessions.filter((session) => session.id !== sessionId);
    await this.#persist();
  }

  async revokeInvite(inviteId: string): Promise<void> {
    const state = this.#requireState();
    state.invites = state.invites.filter((invite) => invite.id !== inviteId);
    await this.#persist();
  }

  #createSession(member: StoredMember): AuthenticatedMember {
    const state = this.#requireState();
    const sessionToken = randomBytes(32).toString("base64url");
    const sessionExpiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    state.sessions.push({
      id: randomUUID(),
      memberId: member.id,
      tokenHash: hashToken(sessionToken),
      expiresAt: sessionExpiresAt,
      createdAt: new Date().toISOString(),
    });
    return { member: publicMember(member), sessionToken, sessionExpiresAt };
  }

  #requireState(): StoredTeam {
    if (!this.#state) throw new Error("The team server is not configured.");
    return this.#state;
  }

  async #prune(): Promise<void> {
    if (!this.#state) return;
    const now = Date.now();
    this.#state.sessions = this.#state.sessions.filter(
      (session) => Date.parse(session.expiresAt) > now,
    );
    this.#state.invites = this.#state.invites.filter(
      (invite) => invite.usedAt !== null || Date.parse(invite.expiresAt) > now,
    );
    await this.#persist();
  }

  async #persist(): Promise<void> {
    const state = this.#requireState();
    this.#writeChain = this.#writeChain.then(async () => {
      const temporary = `${this.#path}.tmp`;
      await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.#path);
    });
    await this.#writeChain;
  }
}

export function fingerprint(publicKey: string): string {
  return createHash("sha256").update(publicKey).digest("base64url");
}

export function addressUpdatePayload(
  serverId: string,
  apiUrl: string,
  vncHostname: string | null,
): string {
  return JSON.stringify({ version: 1, serverId, apiUrl, vncHostname });
}

async function hashPassword(
  password: string,
): Promise<{ passwordSalt: string; passwordHash: string }> {
  const passwordSalt = randomBytes(16).toString("base64url");
  const passwordHash = Buffer.from((await scrypt(password, passwordSalt, 64)) as Buffer).toString(
    "base64url",
  );
  return { passwordSalt, passwordHash };
}

async function verifyPassword(password: string, member: StoredMember): Promise<boolean> {
  const candidate = Buffer.from((await scrypt(password, member.passwordSalt, 64)) as Buffer);
  const expected = Buffer.from(member.passwordHash, "base64url");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function safeTextEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function publicMember(member: StoredMember): TeamMemberSummary {
  return {
    id: member.id,
    username: member.username,
    role: member.role,
    createdAt: member.createdAt,
    disabled: member.disabled,
  };
}

function validateServerName(value: string): void {
  const normalized = value.trim();
  if (normalized.length < 2 || normalized.length > 64) {
    throw new Error("Server name must contain 2 to 64 characters.");
  }
}

function validateUsername(value: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}$/.test(value.trim())) {
    throw new Error(
      "Username must contain 3 to 32 letters, numbers, dots, dashes, or underscores.",
    );
  }
}

function validatePassword(value: string): void {
  if (value.length < 12 || value.length > 256) {
    throw new Error("Password must contain 12 to 256 characters.");
  }
}

function isStoredTeam(value: unknown): value is StoredTeam {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<StoredTeam>;
  return (
    record.version === 1 &&
    typeof record.serverId === "string" &&
    typeof record.serverName === "string" &&
    typeof record.publicKey === "string" &&
    typeof record.privateKey === "string" &&
    Array.isArray(record.members) &&
    Array.isArray(record.invites) &&
    Array.isArray(record.sessions)
  );
}
