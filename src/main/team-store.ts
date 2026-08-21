import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  sign,
  timingSafeEqual,
} from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { avatarFileExtension, isAvatarMimeType, isValidAvatarImage } from "@openbot/contracts/avatar-images";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  AvatarImageInput,
  CentralAuthUser,
  TeamInviteSummary,
  TeamMemberSummary,
  TeamRole,
  TeamSessionSummary,
} from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { normalizeEmailAddress, slugifyTeamServerName } from "@openbot/contracts/validation";

const scrypt = promisify(scryptCallback);
const INVITE_TTL_MS = 24 * 60 * 60 * 1_000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

interface StoredMember extends TeamMemberSummary {
  passwordSalt?: string;
  passwordHash?: string;
}

interface StoredInvite {
  id: string;
  tokenHash: string;
  role: Exclude<TeamRole, "owner">;
  expiresAt: string;
  usedAt: string | null;
  email?: string | null;
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
  serverLogo?: {
    version: string;
    mimeType: AvatarImageInput["mimeType"];
  };
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
  logoVersion: string | null;
}

export interface CreatedInvite {
  id: string;
  role: Exclude<TeamRole, "owner">;
  token: string;
  expiresAt: string;
  email: string | null;
}

export interface TeamInvitePreview {
  role: Exclude<TeamRole, "owner">;
  expiresAt: string;
  emailBound: boolean;
}

export interface AuthenticatedMember {
  member: TeamMemberSummary;
  sessionToken: string;
  sessionExpiresAt: string;
}

export class TeamStore {
  readonly #path: string;
  readonly #logoRoot: string;
  #state: StoredTeam | null = null;
  #writeChain = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
    this.#logoRoot = join(dirname(path), `${basename(path)}.assets`, "logo");
  }

  async initialize(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.#path, "utf8"));
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
      logoVersion: this.#state.serverLogo?.version ?? null,
    };
  }

  getOwnerEmail(): string | null {
    return this.#state?.members.find((member) => member.role === "owner")?.email ?? null;
  }

  assertOwnerAccount(user: CentralAuthUser): void {
    const owner = this.#state?.members.find((member) => member.role === "owner");
    if (!owner?.email) {
      throw new Error("This host is not linked to an OpenBot owner account.");
    }
    if (normalizeEmail(user.email) !== normalizeEmail(owner.email)) {
      throw new Error("Sign in with the OpenBot email that created this host.");
    }
  }

  getIdentityProof(challenge: string): (TeamIdentity & { challenge: string; signature: string }) | null {
    const identity = this.getIdentity();
    if (!identity || !this.#state || !/^[A-Za-z0-9_-]{16,128}$/.test(challenge)) return null;
    const signature = sign(null, Buffer.from(challenge), this.#state.privateKey).toString("base64url");
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
          email: null,
          name: null,
          avatarUrl: null,
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
    const identity = this.getIdentity();
    if (!identity) throw new Error("The team identity could not be created.");
    return identity;
  }

  async configureWithAccount(
    serverName: string,
    user: CentralAuthUser,
    logo?: AvatarImageInput | null,
  ): Promise<TeamIdentity> {
    if (this.#state) throw new Error("The team server is already configured.");
    validateServerName(serverName);
    const email = normalizeEmail(user.email);
    const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const serverLogo = logo ? await this.#writeLogo(logo) : undefined;
    this.#state = {
      version: 1,
      serverId: randomUUID(),
      serverName: serverName.trim(),
      enabledOnLaunch: false,
      publicKey,
      privateKey,
      ...(serverLogo ? { serverLogo } : {}),
      members: [
        {
          id: randomUUID(),
          username: email,
          email,
          name: normalizeName(user.name),
          avatarUrl: normalizeAvatarUrl(user.avatarUrl),
          role: "owner",
          disabled: false,
          createdAt: new Date().toISOString(),
        },
      ],
      invites: [],
      sessions: [],
    };
    try {
      await this.#persist();
    } catch (error) {
      this.#state = null;
      if (serverLogo) await this.#removeLogo(serverLogo).catch(() => undefined);
      throw error;
    }
    const identity = this.getIdentity();
    if (!identity) throw new Error("The team identity could not be created.");
    return identity;
  }

  async updateIdentity(input: { serverName?: string; logo?: AvatarImageInput | null }): Promise<TeamIdentity> {
    const state = this.#requireState();
    if (input.serverName !== undefined) validateServerName(input.serverName);
    if (input.serverName === undefined && input.logo === undefined) {
      const identity = this.getIdentity();
      if (!identity) throw new Error("This OpenBot has not been configured.");
      return identity;
    }

    const previousName = state.serverName;
    const previousLogo = state.serverLogo;
    const nextLogo =
      input.logo === undefined ? previousLogo : input.logo === null ? undefined : await this.#writeLogo(input.logo);
    if (input.serverName !== undefined) state.serverName = input.serverName.trim();
    state.serverLogo = nextLogo;
    try {
      await this.#persist();
    } catch (error) {
      state.serverName = previousName;
      state.serverLogo = previousLogo;
      if (nextLogo && nextLogo.version !== previousLogo?.version) {
        await this.#removeLogo(nextLogo).catch(() => undefined);
      }
      throw error;
    }
    if (previousLogo && previousLogo.version !== nextLogo?.version) {
      await this.#removeLogo(previousLogo).catch(() => undefined);
    }
    const identity = this.getIdentity();
    if (!identity) throw new Error("The team identity could not be updated.");
    return identity;
  }

  resolveLogo(): { path: string; mimeType: AvatarImageInput["mimeType"]; version: string } | null {
    const logo = this.#state?.serverLogo;
    if (!logo) return null;
    return {
      path: join(this.#logoRoot, `${logo.version}.${avatarFileExtension(logo.mimeType)}`),
      mimeType: logo.mimeType,
      version: logo.version,
    };
  }

  async #writeLogo(image: AvatarImageInput): Promise<NonNullable<StoredTeam["serverLogo"]>> {
    if (!isValidAvatarImage(image.mimeType, image.bytes)) {
      throw new Error("Choose a valid PNG, JPEG, or WebP image up to 512 KB.");
    }
    const version = randomUUID();
    const target = join(this.#logoRoot, `${version}.${avatarFileExtension(image.mimeType)}`);
    const temporary = `${target}.tmp`;
    await mkdir(this.#logoRoot, { recursive: true, mode: 0o700 });
    await writeFile(temporary, image.bytes, { mode: 0o600 });
    await rename(temporary, target);
    return { version, mimeType: image.mimeType };
  }

  #removeLogo(logo: NonNullable<StoredTeam["serverLogo"]>): Promise<void> {
    return rm(join(this.#logoRoot, `${logo.version}.${avatarFileExtension(logo.mimeType)}`), { force: true });
  }

  async setEnabledOnLaunch(enabled: boolean): Promise<void> {
    const state = this.#requireState();
    state.enabledOnLaunch = enabled;
    await this.#persist();
  }

  listMembers(): TeamMemberSummary[] {
    return this.#requireState().members.map(publicMember);
  }

  getMember(memberId: string): TeamMemberSummary | null {
    const member = this.#state?.members.find((candidate) => candidate.id === memberId);
    return member ? publicMember(member) : null;
  }

  listInvites(): TeamInviteSummary[] {
    return this.#requireState().invites.map((invite) => ({
      id: invite.id,
      role: invite.role,
      expiresAt: invite.expiresAt,
      usedAt: invite.usedAt,
      email: invite.email ?? null,
    }));
  }

  listSessions(): TeamSessionSummary[] {
    const state = this.#requireState();
    return state.sessions.map((session) => ({
      id: session.id,
      memberId: session.memberId,
      username: state.members.find((member) => member.id === session.memberId)?.username ?? "unknown",
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
    }));
  }

  async createInvite(role: Exclude<TeamRole, "owner">, emailInput?: string): Promise<CreatedInvite> {
    if (role !== "admin" && role !== "member") throw new Error("Invalid invite role.");
    const state = this.#requireState();
    const activeInvites = state.invites.filter(
      (invite) => invite.usedAt === null && Date.parse(invite.expiresAt) > Date.now(),
    ).length;
    if (activeInvites >= INPUT_LIMITS.activeInvites) {
      throw new Error(`A host can have up to ${INPUT_LIMITS.activeInvites} active invitations.`);
    }
    const token = randomBytes(32).toString("base64url");
    const email = emailInput?.trim() ? normalizeEmail(emailInput) : null;
    const invite: StoredInvite = {
      id: randomUUID(),
      tokenHash: hashToken(token),
      role,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
      usedAt: null,
      email,
    };
    state.invites.push(invite);
    await this.#persist();
    return { id: invite.id, role, token, expiresAt: invite.expiresAt, email };
  }

  previewInvite(token: string): TeamInvitePreview {
    const invite = this.#findUsableInvite(token);
    if (!invite) throw new Error("The invitation is invalid or expired.");
    return {
      role: invite.role,
      expiresAt: invite.expiresAt,
      emailBound: Boolean(invite.email),
    };
  }

  async acceptInviteWithAccount(token: string, user: CentralAuthUser): Promise<AuthenticatedMember> {
    const state = this.#requireState();
    const email = normalizeEmail(user.email);
    const invite = this.#findUsableInvite(token);
    if (!invite) throw new Error("The invitation is invalid or expired.");
    if (invite.email && invite.email !== email) {
      throw new Error("This invitation belongs to a different email address.");
    }
    const existingMember = state.members.find((member) => member.email === email || member.username === email);
    if (existingMember) {
      if (existingMember.disabled) throw new Error("This team member is disabled.");
      existingMember.email = email;
      existingMember.username = email;
      existingMember.name = normalizeName(user.name);
      existingMember.avatarUrl = normalizeAvatarUrl(user.avatarUrl);
      invite.usedAt = new Date().toISOString();
      const result = this.#createSession(existingMember);
      await this.#persist();
      return result;
    }
    if (state.members.length >= INPUT_LIMITS.teamMembers) {
      throw new Error(`A host can have up to ${INPUT_LIMITS.teamMembers} members.`);
    }
    const member: StoredMember = {
      id: randomUUID(),
      username: email,
      email,
      name: normalizeName(user.name),
      avatarUrl: normalizeAvatarUrl(user.avatarUrl),
      role: invite.role,
      disabled: false,
      createdAt: new Date().toISOString(),
    };
    invite.usedAt = new Date().toISOString();
    state.members.push(member);
    const result = this.#createSession(member);
    await this.#persist();
    return result;
  }

  async loginWithAccount(user: CentralAuthUser): Promise<AuthenticatedMember> {
    const state = this.#requireState();
    const email = normalizeEmail(user.email);
    const member = state.members.find(
      (candidate) => (candidate.email === email || candidate.username === email) && !candidate.disabled,
    );
    if (!member) throw new Error("This OpenBot account is not a member of the team.");
    member.email = email;
    member.username = email;
    member.name = normalizeName(user.name);
    member.avatarUrl = normalizeAvatarUrl(user.avatarUrl);
    const result = this.#createSession(member);
    await this.#persist();
    return result;
  }

  async acceptInvite(token: string, username: string, password: string): Promise<AuthenticatedMember> {
    validateUsername(username);
    validatePassword(password);
    const state = this.#requireState();
    const normalizedUsername = username.trim().toLowerCase();
    if (state.members.some((member) => member.username === normalizedUsername)) {
      throw new Error("This username is already in use.");
    }
    const invite = this.#findUsableInvite(token);
    if (!invite) throw new Error("The invitation is invalid or expired.");
    if (invite.email) throw new Error("This invitation requires a verified OpenBot account.");
    if (state.members.length >= INPUT_LIMITS.teamMembers) {
      throw new Error(`A host can have up to ${INPUT_LIMITS.teamMembers} members.`);
    }
    const credentials = await hashPassword(password);
    const member: StoredMember = {
      id: randomUUID(),
      username: normalizedUsername,
      email: null,
      name: null,
      avatarUrl: null,
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
    return this.authenticateSession(token)?.member ?? null;
  }

  authenticateSession(
    token: string,
  ): { member: TeamMemberSummary; sessionId: string; sessionExpiresAt: string } | null {
    if (!this.#state || !token) return null;
    const tokenHash = hashToken(token);
    const session = this.#state.sessions.find(
      (candidate) => Date.parse(candidate.expiresAt) > Date.now() && safeTextEqual(candidate.tokenHash, tokenHash),
    );
    if (!session) return null;
    const member = this.#state.members.find((candidate) => candidate.id === session.memberId && !candidate.disabled);
    return member ? { member: publicMember(member), sessionId: session.id, sessionExpiresAt: session.expiresAt } : null;
  }

  async logout(token: string): Promise<void> {
    const state = this.#requireState();
    const tokenHash = hashToken(token);
    state.sessions = state.sessions.filter((candidate) => !safeTextEqual(candidate.tokenHash, tokenHash));
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

  async removeMember(memberId: string): Promise<void> {
    const state = this.#requireState();
    const member = state.members.find((candidate) => candidate.id === memberId);
    if (!member) throw new Error("Team member not found.");
    if (member.role === "owner") throw new Error("The owner account cannot be removed.");
    state.members = state.members.filter((candidate) => candidate.id !== memberId);
    state.sessions = state.sessions.filter((session) => session.memberId !== memberId);
    await this.#persist();
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

  async syncAccount(user: CentralAuthUser): Promise<boolean> {
    const state = this.#requireState();
    const email = normalizeEmail(user.email);
    const member = state.members.find((candidate) => candidate.email === email || candidate.username === email);
    if (!member) return false;
    const name = normalizeName(user.name);
    const avatarUrl = normalizeAvatarUrl(user.avatarUrl);
    if (
      member.email === email &&
      member.username === email &&
      member.name === name &&
      (member.avatarUrl ?? null) === avatarUrl
    ) {
      return false;
    }
    member.email = email;
    member.username = email;
    member.name = name;
    member.avatarUrl = avatarUrl;
    await this.#persist();
    return true;
  }

  #createSession(member: StoredMember): AuthenticatedMember {
    const state = this.#requireState();
    const memberSessions = state.sessions
      .filter((session) => session.memberId === member.id)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const excess = memberSessions.length - INPUT_LIMITS.sessionsPerMember + 1;
    if (excess > 0) {
      const removedIds = new Set(memberSessions.slice(0, excess).map((session) => session.id));
      state.sessions = state.sessions.filter((session) => !removedIds.has(session.id));
    }
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

  #findUsableInvite(token: string): StoredInvite | undefined {
    return this.#requireState().invites.find(
      (candidate) =>
        candidate.usedAt === null &&
        Date.parse(candidate.expiresAt) > Date.now() &&
        safeTextEqual(candidate.tokenHash, hashToken(token)),
    );
  }

  #requireState(): StoredTeam {
    if (!this.#state) throw new Error("The team server is not configured.");
    return this.#state;
  }

  async #prune(): Promise<void> {
    if (!this.#state) return;
    const now = Date.now();
    this.#state.sessions = this.#state.sessions.filter((session) => Date.parse(session.expiresAt) > now);
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

async function hashPassword(password: string): Promise<{ passwordSalt: string; passwordHash: string }> {
  const passwordSalt = randomBytes(16).toString("base64url");
  const passwordHash = Buffer.from(await derivePasswordBytes(password, passwordSalt)).toString("base64url");
  return { passwordSalt, passwordHash };
}

async function verifyPassword(password: string, member: StoredMember): Promise<boolean> {
  if (!member.passwordSalt || !member.passwordHash) return false;
  const candidate = Buffer.from(await derivePasswordBytes(password, member.passwordSalt));
  const expected = Buffer.from(member.passwordHash, "base64url");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

async function derivePasswordBytes(password: string, salt: string): Promise<Uint8Array> {
  const result = await scrypt(password, salt, 64);
  if (!(result instanceof Uint8Array)) throw new Error("Password hashing returned invalid data.");
  return result;
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
    email: member.email ?? null,
    name: member.name ?? null,
    avatarUrl: member.avatarUrl ?? null,
    role: member.role,
    createdAt: member.createdAt,
    disabled: member.disabled,
  };
}

function normalizeEmail(value: string): string {
  const normalized = normalizeEmailAddress(value);
  if (!normalized) throw new Error("Enter a valid email address.");
  return normalized;
}

function normalizeName(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  if (normalized.length > INPUT_LIMITS.accountName) throw new Error("Account name is too long.");
  return normalized || null;
}

function normalizeAvatarUrl(value: string | null): string | null {
  if (!value) return null;
  if (value.length > INPUT_LIMITS.avatarUrl) throw new Error("The account avatar URL is too long.");
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("The account avatar URL is invalid.");
  }
  return url.toString();
}

function validateServerName(value: string): void {
  const normalized = value.trim();
  if (normalized.length < INPUT_LIMITS.serverNameMin || normalized.length > INPUT_LIMITS.serverName) {
    throw new Error(`Server name must contain ${INPUT_LIMITS.serverNameMin} to ${INPUT_LIMITS.serverName} characters.`);
  }
  if (slugifyTeamServerName(normalized).length < INPUT_LIMITS.serverNameMin) {
    throw new Error("Server name must produce a valid public hostname.");
  }
}

function validateUsername(value: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}$/.test(value.trim())) {
    throw new Error("Username must contain 3 to 32 letters, numbers, dots, dashes, or underscores.");
  }
}

function validatePassword(value: string): void {
  if (value.length < 12 || value.length > 256) {
    throw new Error("Password must contain 12 to 256 characters.");
  }
}

function isStoredTeam(value: unknown): value is StoredTeam {
  if (!isDynamicRecord(value)) return false;
  const record = value;
  const logo = record.serverLogo;
  const validLogo =
    logo === undefined ||
    (isDynamicRecord(logo) && isString(logo.version) && isString(logo.mimeType) && isAvatarMimeType(logo.mimeType));
  return (
    record.version === 1 &&
    isString(record.serverId) &&
    isString(record.serverName) &&
    isString(record.publicKey) &&
    isString(record.privateKey) &&
    Array.isArray(record.members) &&
    Array.isArray(record.invites) &&
    Array.isArray(record.sessions) &&
    validLogo
  );
}
