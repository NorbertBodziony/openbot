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

export class TeamStoreError extends Error {}

interface StoredMember extends TeamMemberSummary {
  accountId?: string;
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

/**
 * The file holds one host per OpenBot account, so switching accounts cannot hand the
 * new account the previous one's server. `hosts` is append-only - a host is never
 * removed when its owner signs out, because this file is user data with no backup.
 */
interface StoredTeamFile {
  version: 2;
  /** The account whose host is active, so a restart activates it before the network answers. */
  activeAccountId: string | null;
  hosts: StoredTeam[];
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

export interface RemoteDirectoryMember {
  membershipId: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  role: TeamRole;
  status: "active" | "revoked";
  createdAt: number;
}

export class TeamStore {
  readonly #path: string;
  readonly #logoRoot: string;
  #file: StoredTeamFile = { version: 2, activeAccountId: null, hosts: [] };
  /** The host of the signed-in account. Every other method reads this one, never `#file.hosts`. */
  #state: StoredTeam | null = null;
  readonly #remoteSessions = new Map<
    string,
    { member: TeamMemberSummary; sessionId: string; createdAt: string; sessionExpiresAt: string }
  >();
  #writeChain = Promise.resolve();
  /**
   * The file exists but is neither a v2 envelope nor a v1 record - a file a newer build
   * wrote, or a damaged one. `#file` is empty only because something else owns this path,
   * so writing would destroy the user's only copy. Nothing here is backed up.
   */
  #unreadableFile = false;

  constructor(path: string) {
    this.#path = path;
    this.#logoRoot = join(dirname(path), `${basename(path)}.assets`, "logo");
  }

  async initialize(): Promise<void> {
    let migrated = false;
    try {
      const parsed = JSON.parse(await readFile(this.#path, "utf8"));
      if (isStoredTeamFile(parsed)) {
        this.#file = parsed;
      } else if (isStoredTeam(parsed)) {
        this.#file = { version: 2, activeAccountId: ownerAccountId(parsed), hosts: [parsed] };
        migrated = true;
      } else {
        this.#unreadableFile = true;
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const activeAccountId = this.#file.activeAccountId;
    this.#state =
      (activeAccountId === null
        ? // A host that predates accounts, or one upgraded from a file where the owner
          // account was never recorded. Activating it keeps an offline upgrade showing the
          // host it showed yesterday. A host left behind by a sign-out has an owner account,
          // so signing out still unbinds it.
          this.#file.hosts.find((host) => ownerAccountId(host) === null)
        : this.#file.hosts.find((host) => ownerAccountId(host) === activeAccountId)) ?? null;
    if (migrated) await this.#persistFile();
    if (this.#state) await this.#prune();
  }

  /**
   * Binds the store to `user`'s own host, adopting a host whose owner predates account
   * sign-in. An account with no host leaves the store unconfigured rather than borrowing
   * another account's.
   */
  async activateAccount(user: CentralAuthUser): Promise<void> {
    const email = normalizeEmail(user.email);
    const hosts = this.#file.hosts;
    const unbound = hosts.find((host) => {
      const owner = hostOwner(host);
      return owner !== undefined && !owner.accountId && !owner.email;
    });
    const previousState = this.#state;
    const previousAccountId = this.#file.activeAccountId;
    this.#state =
      hosts.find((host) => ownerAccountId(host) === user.id) ??
      hosts.find((host) => {
        const ownerEmail = hostOwner(host)?.email;
        return ownerEmail ? normalizeEmail(ownerEmail) === email : false;
      }) ??
      unbound ??
      null;
    this.#file.activeAccountId = user.id;
    // A host configured before accounts existed has no owner email to match on next time,
    // so adopting it has to write the binding rather than rely on `syncAccount`.
    const adopted = this.#state && this.#state === unbound ? hostOwner(this.#state) : undefined;
    const adoptedBefore = adopted && { accountId: adopted.accountId, email: adopted.email };
    if (adopted) {
      adopted.accountId = user.id;
      adopted.email = email;
    }
    try {
      await this.#recordActiveAccount();
    } catch (error) {
      // Staying bound to a host the file does not name would have the status report one
      // account while every write went to another.
      this.#state = previousState;
      this.#file.activeAccountId = previousAccountId;
      if (adopted && adoptedBefore) Object.assign(adopted, adoptedBefore);
      throw error;
    }
    if (this.#state) {
      await this.syncAccount(user);
      await this.#prune();
    }
  }

  /** Signing out unbinds the host without removing it - signing back in restores it. */
  async deactivate(): Promise<void> {
    const previousState = this.#state;
    const previousAccountId = this.#file.activeAccountId;
    this.#state = null;
    this.#file.activeAccountId = null;
    try {
      await this.#recordActiveAccount();
    } catch (error) {
      this.#state = previousState;
      this.#file.activeAccountId = previousAccountId;
      throw error;
    }
  }

  /**
   * A file with no host records nothing an activation could change, so there is nothing to
   * write - which is also what keeps signing in from failing, or from overwriting a file
   * this store could not read. Configuring a server still refuses that file outright.
   */
  async #recordActiveAccount(): Promise<void> {
    if (this.#file.hosts.length === 0) return;
    await this.#persistFile();
  }

  get configured(): boolean {
    return this.#state !== null;
  }

  getIdentity(): TeamIdentity | null {
    return this.#state ? identityOf(this.#state) : null;
  }

  getOwnerEmail(): string | null {
    return this.#state?.members.find((member) => member.role === "owner")?.email ?? null;
  }

  getOwnerMemberId(): string | null {
    return this.#state?.members.find((member) => member.role === "owner")?.id ?? null;
  }

  getOwnerAnalyticsIdentity(): Pick<CentralAuthUser, "id" | "email"> | null {
    const owner = this.#state?.members.find((member) => member.role === "owner");
    return owner?.accountId && owner.email ? { id: owner.accountId, email: owner.email } : null;
  }

  assertOwnerAccount(user: CentralAuthUser): void {
    const owner = this.#state?.members.find((member) => member.role === "owner");
    if (!owner?.email) {
      throw new TeamStoreError("This host is not linked to an OpenBot owner account.");
    }
    if (normalizeEmail(user.email) !== normalizeEmail(owner.email)) {
      throw new TeamStoreError("Sign in with the OpenBot email that created this host.");
    }
  }

  getIdentityProof(challenge: string): (TeamIdentity & { challenge: string; signature: string }) | null {
    const identity = this.getIdentity();
    if (!identity || !this.#state || !/^[A-Za-z0-9_-]{16,128}$/.test(challenge)) return null;
    const signature = sign(null, Buffer.from(challenge), this.#state.privateKey).toString("base64url");
    return { ...identity, challenge, signature };
  }

  signRemoteAuthentication(transcript: string): string {
    if (!this.#state) throw new TeamStoreError("The team host is not configured.");
    return sign(null, Buffer.from(transcript), this.#state.privateKey).toString("base64url");
  }

  /**
   * The password path, used by the development connection and by tests. It creates an
   * owner-less host and deliberately leaves `activeAccountId` alone - no account owns it
   * yet, and the first one to activate adopts it. `#assertNoHostFor` is what keeps a
   * second owner-less host from being created beside it.
   */
  async configure(serverName: string, username: string, password: string): Promise<TeamIdentity> {
    if (this.#state) throw new TeamStoreError("The team server is already configured.");
    validateServerName(serverName);
    validateUsername(username);
    validatePassword(password);
    const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const credentials = await hashPassword(password);
    // Hashing yields, so a second request could have configured a host meanwhile.
    if (this.#state) throw new TeamStoreError("The team server is already configured.");
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
    this.#file.hosts.push(this.#state);
    try {
      await this.#persistFile();
    } catch (error) {
      this.#file.hosts.pop();
      this.#state = null;
      throw error;
    }
    const identity = this.getIdentity();
    if (!identity) throw new Error("The team identity could not be created.");
    return identity;
  }

  async configureWithAccount(
    serverName: string,
    user: CentralAuthUser,
    logo?: AvatarImageInput | null,
  ): Promise<TeamIdentity> {
    const email = normalizeEmail(user.email);
    this.#assertNoHostFor(user.id, email);
    validateServerName(serverName);
    // Both `activateAccount` and `deactivate` set this synchronously, so comparing it
    // after the awaits below is a reliable answer to "is this still the account that
    // asked?" - a configuration finishing under someone else's session would otherwise
    // rebind the store to the account that has just signed out.
    const activeAccountBefore = this.#file.activeAccountId;
    const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const serverLogo = logo ? await this.#writeLogo(logo) : undefined;
    try {
      // `#writeLogo` yields, so two concurrent requests could both have passed the guard
      // above. Re-checking is what stops one account owning two stored hosts, where a
      // restart would activate the one the status never showed.
      this.#assertNoHostFor(user.id, email);
      if (this.#file.activeAccountId !== activeAccountBefore) {
        throw new TeamStoreError("The signed-in account changed while this server was being created.");
      }
    } catch (error) {
      if (serverLogo) await this.#removeLogo(serverLogo).catch(() => undefined);
      throw error;
    }
    const created: StoredTeam = {
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
          accountId: user.id,
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
    this.#file.hosts.push(created);
    const previousState = this.#state;
    const previousAccountId = this.#file.activeAccountId;
    this.#state = created;
    this.#file.activeAccountId = user.id;
    try {
      await this.#persistFile();
    } catch (error) {
      this.#file.hosts = this.#file.hosts.filter((host) => host !== created);
      if (this.#state === created) {
        this.#state = previousState;
        this.#file.activeAccountId = previousAccountId;
      }
      if (serverLogo) await this.#removeLogo(serverLogo).catch(() => undefined);
      throw error;
    }
    // Writing the file yields as well. The host stays - it is on disk and it belongs to the
    // account that asked for it - but the caller must not go on to apply this configuration,
    // its logo and its remote registration, to whichever host is active now.
    if (this.#state !== created) {
      throw new TeamStoreError("The signed-in account changed while this server was being created.");
    }
    return identityOf(created);
  }

  async updateIdentity(input: { serverName?: string; logo?: AvatarImageInput | null }): Promise<TeamIdentity> {
    const state = this.#requireState();
    if (input.serverName !== undefined) validateServerName(input.serverName);
    if (input.serverName === undefined && input.logo === undefined) {
      const identity = this.getIdentity();
      if (!identity) throw new TeamStoreError("This OpenBot has not been configured.");
      return identity;
    }

    const previousName = state.serverName;
    const previousLogo = state.serverLogo;
    const nextLogo =
      input.logo === undefined ? previousLogo : input.logo === null ? undefined : await this.#writeLogo(input.logo);
    // Writing the logo can outlive this host. `#persist` only requires *some* active host, so
    // without this the name and image asked for here would land on whichever host became
    // active meanwhile - and the caller would be handed that other account's identity back.
    if (this.#state !== state) {
      if (nextLogo && nextLogo.version !== previousLogo?.version) {
        await this.#removeLogo(nextLogo).catch(() => undefined);
      }
      throw new TeamStoreError("This server is no longer the active one for the signed-in account.");
    }
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
    return identityOf(state);
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
      throw new TeamStoreError("Choose a valid PNG, JPEG, or WebP image up to 512 KB.");
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

  /**
   * `serverId` names the host the caller decided this for. Publishing and unpublishing
   * both span awaits an account switch can land in, and the launch preference of one
   * account's host must never be written onto another's.
   */
  async setEnabledOnLaunch(serverId: string, enabled: boolean): Promise<void> {
    const state = this.#requireState();
    if (state.serverId !== serverId) {
      throw new TeamStoreError("This server is no longer the active one for the signed-in account.");
    }
    state.enabledOnLaunch = enabled;
    await this.#persist();
  }

  listMembers(): TeamMemberSummary[] {
    const members = this.#requireState().members.map(publicMember);
    const known = new Set(members.map((member) => member.id));
    for (const remote of this.#remoteSessions.values()) {
      if (!known.has(remote.member.id) && Date.parse(remote.sessionExpiresAt) > Date.now()) {
        members.push(structuredClone(remote.member));
        known.add(remote.member.id);
      }
    }
    return members;
  }

  /**
   * `serverId` names the host the caller loaded this directory for. Signing into another
   * account swaps the active host, so a directory that was already in flight would
   * otherwise rewrite the new account's owner membership and disable its members.
   */
  async syncRemoteDirectory(serverId: string, remoteMembers: RemoteDirectoryMember[]): Promise<void> {
    const state = this.#requireState();
    if (state.serverId !== serverId) {
      throw new TeamStoreError("This server is no longer the active one for the signed-in account.");
    }
    const remoteOwner = remoteMembers.find((member) => member.role === "owner");
    const localOwner = state.members.find((member) => member.role === "owner");
    if (remoteOwner && localOwner && remoteOwner.membershipId !== localOwner.id) {
      if (state.members.some((member) => member.id === remoteOwner.membershipId)) {
        throw new TeamStoreError("The control-plane owner membership conflicts with this host.");
      }
      const previousOwnerId = localOwner.id;
      localOwner.id = remoteOwner.membershipId;
      for (const session of state.sessions) {
        if (session.memberId === previousOwnerId) session.memberId = remoteOwner.membershipId;
      }
    }
    const remoteIds = new Set(remoteMembers.map((member) => member.membershipId));
    for (const remote of remoteMembers) {
      const member = state.members.find((candidate) => candidate.id === remote.membershipId);
      if (!member) {
        if (remote.role === "owner")
          throw new TeamStoreError("The control-plane owner identity does not match this host.");
        state.members.push({
          id: remote.membershipId,
          username: normalizeEmail(remote.email),
          email: normalizeEmail(remote.email),
          name: normalizeName(remote.name),
          avatarUrl: normalizeAvatarUrl(remote.avatarUrl),
          role: remote.role,
          disabled: remote.status !== "active",
          createdAt: new Date(remote.createdAt).toISOString(),
        });
        continue;
      }
      member.username = normalizeEmail(remote.email);
      member.email = normalizeEmail(remote.email);
      member.name = normalizeName(remote.name);
      member.avatarUrl = normalizeAvatarUrl(remote.avatarUrl);
      member.role = remote.role;
      member.disabled = remote.status !== "active";
    }
    for (const member of state.members) {
      if (member.role !== "owner" && !remoteIds.has(member.id)) member.disabled = true;
    }
    await this.#persist();
  }

  openRemoteSession(input: {
    sessionId: string;
    membershipId: string;
    userId: string;
    role: TeamRole;
    expiresAt?: number;
  }): AuthenticatedMember {
    const sessionToken = randomBytes(32).toString("base64url");
    const sessionExpiresAt = new Date(input.expiresAt ?? Date.now() + SESSION_TTL_MS).toISOString();
    const stored = this.#requireState().members.find((member) => member.id === input.membershipId);
    const member: TeamMemberSummary = stored
      ? { ...publicMember(stored), role: input.role, disabled: false }
      : {
          id: input.membershipId,
          username: input.userId,
          email: null,
          name: null,
          role: input.role,
          createdAt: new Date().toISOString(),
          disabled: false,
        };
    this.#remoteSessions.set(hashToken(sessionToken), {
      member,
      sessionId: input.sessionId,
      createdAt: new Date().toISOString(),
      sessionExpiresAt,
    });
    return { member: structuredClone(member), sessionToken, sessionExpiresAt };
  }

  closeRemoteSession(sessionId: string): void {
    for (const [tokenHash, session] of this.#remoteSessions) {
      if (session.sessionId === sessionId) this.#remoteSessions.delete(tokenHash);
    }
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
    const persisted = state.sessions.map((session) => ({
      id: session.id,
      memberId: session.memberId,
      username: state.members.find((member) => member.id === session.memberId)?.username ?? "unknown",
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
    }));
    const now = Date.now();
    const remote: TeamSessionSummary[] = [];
    for (const [tokenHash, session] of this.#remoteSessions) {
      if (Date.parse(session.sessionExpiresAt) <= now) {
        this.#remoteSessions.delete(tokenHash);
        continue;
      }
      remote.push({
        id: session.sessionId,
        memberId: session.member.id,
        username: session.member.username,
        createdAt: session.createdAt,
        expiresAt: session.sessionExpiresAt,
      });
    }
    return [...persisted, ...remote];
  }

  async createInvite(role: Exclude<TeamRole, "owner">, emailInput?: string): Promise<CreatedInvite> {
    if (role !== "admin" && role !== "member") throw new TeamStoreError("Invalid invite role.");
    const state = this.#requireState();
    const activeInvites = state.invites.filter(
      (invite) => invite.usedAt === null && Date.parse(invite.expiresAt) > Date.now(),
    ).length;
    if (activeInvites >= INPUT_LIMITS.activeInvites) {
      throw new TeamStoreError(`A host can have up to ${INPUT_LIMITS.activeInvites} active invitations.`);
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
    if (!invite) throw new TeamStoreError("The invitation is invalid or expired.");
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
    if (!invite) throw new TeamStoreError("The invitation is invalid or expired.");
    if (invite.email && invite.email !== email) {
      throw new TeamStoreError("This invitation belongs to a different email address.");
    }
    const existingMember = state.members.find((member) => member.email === email || member.username === email);
    if (existingMember) {
      if (existingMember.disabled) throw new TeamStoreError("This team member is disabled.");
      existingMember.email = email;
      existingMember.accountId = user.id;
      existingMember.username = email;
      existingMember.name = normalizeName(user.name);
      existingMember.avatarUrl = normalizeAvatarUrl(user.avatarUrl);
      invite.usedAt = new Date().toISOString();
      const result = this.#createSession(existingMember);
      await this.#persist();
      return result;
    }
    if (state.members.length >= INPUT_LIMITS.teamMembers) {
      throw new TeamStoreError(`A host can have up to ${INPUT_LIMITS.teamMembers} members.`);
    }
    const member: StoredMember = {
      id: randomUUID(),
      accountId: user.id,
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
    if (!member) throw new TeamStoreError("This OpenBot account is not a member of the team.");
    member.email = email;
    member.accountId = user.id;
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
      throw new TeamStoreError("This username is already in use.");
    }
    const invite = this.#findUsableInvite(token);
    if (!invite) throw new TeamStoreError("The invitation is invalid or expired.");
    if (invite.email) throw new TeamStoreError("This invitation requires a verified OpenBot account.");
    if (state.members.length >= INPUT_LIMITS.teamMembers) {
      throw new TeamStoreError(`A host can have up to ${INPUT_LIMITS.teamMembers} members.`);
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
      throw new TeamStoreError("The username or password is incorrect.");
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
    const remote = this.#remoteSessions.get(tokenHash);
    if (remote) {
      if (Date.parse(remote.sessionExpiresAt) > Date.now()) return structuredClone(remote);
      this.#remoteSessions.delete(tokenHash);
    }
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
      throw new TeamStoreError("The current password is incorrect.");
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
    if (!member) throw new TeamStoreError("Team member not found.");
    if (member.role === "owner") throw new TeamStoreError("The owner account cannot be changed.");
    if (patch.role !== undefined) {
      if (patch.role !== "admin" && patch.role !== "member") throw new TeamStoreError("Invalid role.");
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
    if (!member) throw new TeamStoreError("Team member not found.");
    if (member.role === "owner") throw new TeamStoreError("The owner account cannot be removed.");
    state.members = state.members.filter((candidate) => candidate.id !== memberId);
    state.sessions = state.sessions.filter((session) => session.memberId !== memberId);
    await this.#persist();
  }

  async revokeSession(sessionId: string): Promise<void> {
    const state = this.#requireState();
    state.sessions = state.sessions.filter((session) => session.id !== sessionId);
    this.closeRemoteSession(sessionId);
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
      member.accountId === user.id &&
      member.username === email &&
      member.name === name &&
      (member.avatarUrl ?? null) === avatarUrl
    ) {
      return false;
    }
    member.email = email;
    member.accountId = user.id;
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
    if (!this.#state) throw new TeamStoreError("The team server is not configured.");
    return this.#state;
  }

  /**
   * Rejects a second host for one account, and a second host beside an owner-less one.
   * The owner-less check spans every stored host, not just the active one: an inactive
   * one is exactly what the next `activateAccount` adopts, so letting a second accumulate
   * would make that adoption a coin toss.
   */
  #assertNoHostFor(accountId: string, email: string): void {
    const ownerless = this.#file.hosts.some((host) => {
      const owner = hostOwner(host);
      return owner !== undefined && !owner.accountId && !owner.email;
    });
    if (this.#hostFor(accountId, email) || ownerless) {
      throw new TeamStoreError("The team server is already configured.");
    }
  }

  #hostFor(accountId: string, email: string): StoredTeam | undefined {
    return this.#file.hosts.find((host) => {
      const owner = hostOwner(host);
      return owner?.accountId === accountId || (owner?.email ? normalizeEmail(owner.email) === email : false);
    });
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
    this.#requireState();
    await this.#persistFile();
  }

  async #persistFile(): Promise<void> {
    if (this.#unreadableFile) {
      throw new TeamStoreError(
        "This computer's team server file could not be read. Move it aside before configuring a server, so it is not overwritten.",
      );
    }
    const snapshot = structuredClone(this.#file);
    const operation = this.#writeChain.then(async () => {
      const temporary = `${this.#path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, this.#path);
      } finally {
        await rm(temporary, { force: true });
      }
    });
    this.#writeChain = operation.catch(() => undefined);
    await operation;
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
  if (!normalized) throw new TeamStoreError("Enter a valid email address.");
  return normalized;
}

function normalizeName(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  if (normalized.length > INPUT_LIMITS.accountName) throw new TeamStoreError("Account name is too long.");
  return normalized || null;
}

function normalizeAvatarUrl(value: string | null): string | null {
  if (!value) return null;
  if (value.length > INPUT_LIMITS.avatarUrl) throw new TeamStoreError("The account avatar URL is too long.");
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TeamStoreError("The account avatar URL is invalid.");
  }
  return url.toString();
}

function validateServerName(value: string): void {
  const normalized = value.trim();
  if (normalized.length < INPUT_LIMITS.serverNameMin || normalized.length > INPUT_LIMITS.serverName) {
    throw new TeamStoreError(
      `Server name must contain ${INPUT_LIMITS.serverNameMin} to ${INPUT_LIMITS.serverName} characters.`,
    );
  }
  if (slugifyTeamServerName(normalized).length < INPUT_LIMITS.serverNameMin) {
    throw new TeamStoreError("Server name must produce a valid public hostname.");
  }
}

function validateUsername(value: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}$/.test(value.trim())) {
    throw new TeamStoreError("Username must contain 3 to 32 letters, numbers, dots, dashes, or underscores.");
  }
}

function validatePassword(value: string): void {
  if (value.length < 12 || value.length > 256) {
    throw new TeamStoreError("Password must contain 12 to 256 characters.");
  }
}

function identityOf(host: StoredTeam): TeamIdentity {
  return {
    serverId: host.serverId,
    serverName: host.serverName,
    fingerprint: fingerprint(host.publicKey),
    publicKey: host.publicKey,
    enabledOnLaunch: host.enabledOnLaunch,
    logoVersion: host.serverLogo?.version ?? null,
  };
}

function hostOwner(host: StoredTeam): StoredMember | undefined {
  return host.members.find((member) => member.role === "owner");
}

function ownerAccountId(host: StoredTeam): string | null {
  return hostOwner(host)?.accountId ?? null;
}

function isStoredTeamFile(value: unknown): value is StoredTeamFile {
  if (!isDynamicRecord(value)) return false;
  return (
    value.version === 2 &&
    (value.activeAccountId === null || isString(value.activeAccountId)) &&
    Array.isArray(value.hosts) &&
    value.hosts.every((host) => isStoredTeam(host))
  );
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
