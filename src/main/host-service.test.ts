// @vitest-environment node

// `HostService` is what the app binds a Team API host to an account with, and every case here is
// about which account's server it reports - not about a route. It lived in `team-api-server.test.ts`
// until the suite was split by domain, where it was the one block testing a different class.

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CentralAuthUser } from "@openbot/contracts/ipc";
import { afterEach, describe, expect, it } from "vitest";
import { HostService } from "./host-service";
import { createAgents, createBrowser, createMailbox, unimplemented } from "./team-api-server-test-harness";
import { TeamStore } from "./team-store";

const roots: string[] = [];

type HostOptions = ConstructorParameters<typeof HostService>[0];
/**
 * `HostService` forwards these straight to the Team API, so the doubles above are the
 * whole harness it needs. No runtime is started here - these cases are about which
 * account's host the service is bound to.
 */
async function createHostService(
  remote: Partial<
    Pick<
      HostOptions,
      | "listRemoteInvites"
      | "registerRemoteHost"
      | "updateRemoteHostLogo"
      | "listRemoteMembers"
      | "updateRemoteMember"
      | "removeRemoteMember"
      | "createRemoteInvite"
      | "revokeRemoteInvite"
      | "remoteControlPlaneUrl"
      | "sendTeamInviteEmail"
    >
  > = {},
): Promise<{
  service: HostService;
  /** Reports an account exactly as `forwardCentralAuth` does, sign-out included. */
  signIn: (user: CentralAuthUser | null) => Promise<void>;
  /** Holds the team file, so a test can make the store's write fail. */
  root: string;
  /** Announces an account the way the renderer is told, before the queued switch is applied. */
  announce: (user: CentralAuthUser) => void;
}> {
  const root = await mkdtemp(join(tmpdir(), "openbot-host-service-"));
  roots.push(root);
  const store = new TeamStore(join(root, "team.json"));
  await store.initialize();
  let signedIn: CentralAuthUser | null = null;
  const options: HostOptions = {
    appVersion: "0.4.0",
    store,
    agents: { ...createAgents(), adoptConversationReads: unimplemented },
    skills: { listInstalledForChatTags: unimplemented },
    sidebarLayout: {
      getSnapshot: unimplemented,
      mutate: unimplemented,
      removeAgent: unimplemented,
      placeDuplicateAfter: unimplemented,
      on: () => undefined,
      off: () => undefined,
    },
    mailbox: createMailbox(),
    browser: createBrowser(),
    getSignedInUser: () => {
      if (!signedIn) throw new Error("No account is signed in.");
      return signedIn;
    },
    redeemCentralTicket: unimplemented,
    sendTeamInviteEmail: unimplemented,
    ...remote,
  };
  const service = new HostService(options);
  return {
    service,
    root,
    announce: (user) => {
      signedIn = user;
    },
    signIn: async (user) => {
      signedIn = user;
      await service.applySignedInAccount(user);
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type RemoteInvites = Awaited<ReturnType<NonNullable<HostOptions["listRemoteInvites"]>>>;
type RemoteMembers = Awaited<ReturnType<NonNullable<HostOptions["listRemoteMembers"]>>>;
type RemoteInvite = Awaited<ReturnType<NonNullable<HostOptions["createRemoteInvite"]>>>;

describe("HostService account binding", () => {
  const first = { id: "account-a", email: "a@example.com", name: "A", avatarUrl: null };
  const second = { id: "account-b", email: "b@example.com", name: "B", avatarUrl: null };

  it("stops reporting the previous account's server when the account changes", async () => {
    const { service, signIn } = await createHostService();
    await signIn(first);
    await service.configure({ serverName: "Studio Mac" });
    expect(service.getStatus().serverName).toBe("Studio Mac");

    await signIn(second);

    const status = service.getStatus();
    expect(status.configured).toBe(false);
    expect(status.phase).toBe("unconfigured");
    expect(status.serverId).toBeNull();
    expect(status.serverName).toBeNull();
    expect(status.enabledOnLaunch).toBe(false);
  });

  it("stops reporting the previous account's server before the switch is recorded", async () => {
    const { service, signIn } = await createHostService();
    await signIn(first);
    await service.configure({ serverName: "Studio Mac" });

    // What `forwardCentralAuth` calls before it tells the renderer the account changed.
    service.unbindChangedAccount(second);

    expect(service.getStatus().configured).toBe(false);
    expect(service.getStatus().serverId).toBeNull();
    expect(service.getStatus().serverName).toBeNull();
  });

  it("puts the account's server back when the same account is reported after the unbind", async () => {
    const { service, signIn } = await createHostService();
    await signIn(first);
    const identity = await service.configure({ serverName: "Studio Mac" });

    // A sign-out and an immediate sign-in as the same account: the unbind lands first, and
    // the queued switch that follows is the only thing that can bind the host again.
    service.unbindChangedAccount(second);
    await signIn(first);

    expect(service.getStatus().configured).toBe(true);
    expect(service.getStatus().serverId).toBe(identity.serverId);
    expect(service.getStatus().serverName).toBe("Studio Mac");
  });

  it("does not bind the previous account's server when its switch is applied too late", async () => {
    const { service, signIn } = await createHostService();
    await signIn(first);
    await service.configure({ serverName: "Studio Mac" });
    await signIn(second);

    // A's queued switch, arriving after B is the signed-in account.
    await service.applySignedInAccount(first);

    expect(service.getStatus().configured).toBe(false);
    expect(() => service.listMembers()).toThrow("The team server is not configured.");
  });

  it("answers invitations from the host that is active when the read returns", async () => {
    let deliver: (invites: RemoteInvites) => void = () => undefined;
    const loading = new Promise<RemoteInvites>((resolve) => {
      deliver = resolve;
    });
    const { service, signIn } = await createHostService({ listRemoteInvites: () => loading });
    await signIn(second);
    await service.configure({ serverName: "Studio Air" });
    await signIn(first);
    await service.configure({ serverName: "Studio Mac" });

    const pending = service.listInvites();
    await signIn(second);
    deliver([
      {
        inviteId: "invite-1",
        role: "member",
        email: "invited-by-a@example.com",
        expiresAt: Date.now() + 60_000,
        usedAt: null,
        revokedAt: null,
      },
    ]);

    // A's invitation, and the address it was sent to, must not reach B's renderer.
    await expect(pending).resolves.toEqual([]);
  });

  it("does not push a server update to the remote directory once the account has changed", async () => {
    let finishRegistration: () => void = () => undefined;
    const registered = new Promise<void>((resolve) => {
      finishRegistration = resolve;
    });
    let registrationStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      registrationStarted = resolve;
    });
    const logos: string[] = [];
    const { service, signIn } = await createHostService({
      // Naming the server registers it too; only the update's registration is held open.
      registerRemoteHost: (input) => {
        if (input.name !== "Renamed") return Promise.resolve();
        registrationStarted();
        return registered;
      },
      updateRemoteHostLogo: async (hostId) => {
        logos.push(hostId);
        return null;
      },
    });
    await signIn(first);
    await service.configure({ serverName: "Studio Mac" });

    const pending = service.updateIdentity({
      serverName: "Renamed",
      logo: { mimeType: "image/png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
    });
    // The store's own guard covers the window up to here; this is the one after it.
    await started;
    await signIn(second);
    finishRegistration();
    await pending;

    // Uploading it here would send A's image under B's authentication.
    expect(logos).toEqual([]);
  });

  it("does not change a member on the previous account's server once the account has changed", async () => {
    let releaseRead: (members: RemoteMembers) => void = () => undefined;
    const reading = new Promise<RemoteMembers>((resolve) => {
      releaseRead = resolve;
    });
    let readStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    let reads = 0;
    const mutations: string[] = [];
    const { service, signIn } = await createHostService({
      listRemoteMembers: () => {
        reads += 1;
        readStarted();
        return reading;
      },
      updateRemoteMember: async (hostId) => {
        mutations.push(hostId);
      },
      removeRemoteMember: async (hostId) => {
        mutations.push(hostId);
      },
      registerRemoteHost: () => Promise.resolve(),
    });
    await signIn(first);
    await service.configure({ serverName: "Studio Mac" });

    const pending = service.updateMember({ memberId: "member-1", role: "admin" });
    const settled = pending.catch(() => undefined);
    await started;
    await signIn(second);
    releaseRead([
      {
        membershipId: "member-1",
        email: "person@example.com",
        name: null,
        avatarUrl: null,
        role: "member",
        status: "active",
        createdAt: 1_000,
      },
    ]);
    await settled;

    await expect(pending).rejects.toThrow("signed-in account changed");
    // The mutation would have carried B's authorization to A's host.
    expect(mutations).toEqual([]);
    expect(reads).toBe(1);
  });

  it("leaves the new account's status alone when the previous account's registration fails", async () => {
    let failRegistration: (error: Error) => void = () => undefined;
    const registration = new Promise<void>((_resolve, reject) => {
      failRegistration = reject;
    });
    let registrationStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      registrationStarted = resolve;
    });
    const { service, signIn } = await createHostService({
      registerRemoteHost: () => {
        registrationStarted();
        return registration;
      },
    });
    await signIn(first);

    const pending = service.configure({ serverName: "Studio Mac" });
    await started;
    await signIn(second);
    const beforeFailure = service.getStatus();
    failRegistration(new Error("Could not reserve the public address."));
    await pending;

    // B has no server of its own; A's failure must not paint an error over that.
    expect(service.getStatus()).toEqual(beforeFailure);
    expect(service.getStatus().phase).not.toBe("error");
  });

  it("does not email an invitation created for the account that has just been left", async () => {
    let releaseInvite: (invite: RemoteInvite) => void = () => undefined;
    const creating = new Promise<RemoteInvite>((resolve) => {
      releaseInvite = resolve;
    });
    let creationStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      creationStarted = resolve;
    });
    const emails: string[] = [];
    const { service, signIn } = await createHostService({
      registerRemoteHost: () => Promise.resolve(),
      remoteControlPlaneUrl: "https://api.openbot.run",
      createRemoteInvite: () => {
        creationStarted();
        return creating;
      },
      sendTeamInviteEmail: async ({ email }) => {
        emails.push(email);
      },
    });
    await signIn(first);
    await service.configure({ serverName: "Studio Mac" });

    const pending = service.createInvite({ role: "member", email: "guest@example.com" });
    const settled = pending.catch(() => undefined);
    await started;
    await signIn(second);
    releaseInvite({
      inviteId: "invite-1",
      token: "invite-token-that-is-long-enough-for-a-link",
      expiresAt: Date.now() + 60_000,
    });
    await settled;

    await expect(pending).rejects.toThrow("signed-in account changed");
    // The mail would name A's server and go out under B's authentication.
    expect(emails).toEqual([]);
  });

  it("activates the account again after a failed switch instead of leaving it unconfigured", async () => {
    const { service, signIn, root } = await createHostService({ registerRemoteHost: () => Promise.resolve() });
    await signIn(first);
    await service.configure({ serverName: "Studio Mac" });
    await signIn(second);
    const secondIdentity = await service.configure({ serverName: "Loft Mini" });
    await signIn(first);

    // The team file cannot be written while its directory is gone, so recording the switch fails.
    await rm(root, { recursive: true, force: true });
    await expect(signIn(second)).rejects.toThrow();
    expect(service.getStatus().configured).toBe(false);

    await mkdir(root, { recursive: true });
    await signIn(second);
    expect(service.getStatus().serverId).toBe(secondIdentity.serverId);
    expect(service.getStatus().configured).toBe(true);
  });

  it("does not create the previous account's server once another account has been announced", async () => {
    const registrations: string[] = [];
    const { service, signIn, announce } = await createHostService({
      registerRemoteHost: async ({ hostId }) => {
        registrations.push(hostId);
      },
    });
    await signIn(first);

    const pending = service.configure({
      serverName: "Studio Mac",
      logo: { mimeType: "image/png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
    });
    // Announced while the logo and the host are being written, with the switch itself queued.
    announce(second);

    await expect(pending).rejects.toThrow("signed-in account changed");
    expect(service.getStatus().configured).toBe(false);
    // Registering would have reserved A's server under B's authentication.
    expect(registrations).toEqual([]);
    // Nor may what was created stay readable: the owner's address is in there.
    expect(() => service.listMembers()).toThrow("The team server is not configured.");
  });

  it("reports the account's own server again after signing out and back in", async () => {
    const { service, signIn } = await createHostService();
    await signIn(first);
    const identity = await service.configure({ serverName: "Studio Mac" });

    await signIn(null);
    expect(service.getStatus().configured).toBe(false);
    expect(service.getStatus().serverId).toBeNull();

    await signIn(first);
    expect(service.getStatus().serverId).toBe(identity.serverId);
    expect(identity.serverId).not.toBeNull();
    expect(service.getStatus().serverName).toBe("Studio Mac");
  });
});
