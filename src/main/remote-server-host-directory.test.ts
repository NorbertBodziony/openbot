// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { RemoteHostSummary } from "./central-auth-manager";
import { reconcileWebRtcHosts } from "./remote-server-host-directory";
import type { StoredRemoteServer } from "./remote-server-stored-shape";
import { fingerprint } from "./team-store";

function listedHost(hostId: string, overrides: Partial<RemoteHostSummary> = {}): RemoteHostSummary {
  return {
    hostId,
    name: hostId,
    logoKey: null,
    devicePublicKey: `${hostId}-key`,
    authEpoch: 1,
    membershipId: `membership-${hostId}`,
    role: "member",
    ...overrides,
  };
}

function storedHost(hostId: string, overrides: Partial<StoredRemoteServer> = {}): StoredRemoteServer {
  return {
    id: hostId,
    name: hostId,
    apiUrl: `webrtc://${hostId}`,
    fingerprint: fingerprint(`${hostId}-key`),
    publicKey: `${hostId}-key`,
    username: "person@example.com",
    encryptedToken: "",
    remoteDesktopAvailable: false,
    logoVersion: null,
    role: "member",
    transport: "webrtc-v2",
    ...overrides,
  };
}

function reconcile(input: {
  hosts?: RemoteHostSummary[];
  servers?: StoredRemoteServer[];
  localHostId?: string | null;
  hidden?: string[];
  keepOtherTransports?: boolean;
}) {
  return reconcileWebRtcHosts({
    hosts: input.hosts ?? [],
    servers: input.servers ?? [],
    localHostId: input.localHostId ?? null,
    isHiddenHost: (hostId) => (input.hidden ?? []).includes(hostId),
    username: "person@example.com",
    keepOtherTransports: input.keepOtherTransports ?? false,
  });
}

describe("reconcileWebRtcHosts", () => {
  it("keeps the order the user arranged and appends hosts they have not seen", () => {
    const result = reconcile({
      hosts: [listedHost("first"), listedHost("second"), listedHost("third")],
      servers: [storedHost("third"), storedHost("first")],
    });

    expect(result.servers.map((server) => server.id)).toEqual(["third", "first", "second"]);
    expect(result.removedHostIds).toEqual([]);
  });

  it("refuses an advertised key that disagrees with a fingerprint the user already trusts", () => {
    const result = reconcile({
      hosts: [listedHost("host", { devicePublicKey: "attacker-key" })],
      servers: [storedHost("host", { publicKey: undefined, fingerprint: fingerprint("trusted-key") })],
    });

    expect(result.pinnedKeys).toEqual([]);
    expect(result.servers[0]?.publicKey).toBeUndefined();
    expect(result.servers[0]?.fingerprint).toBe(fingerprint("trusted-key"));
  });

  it("keeps a pinned key even when the directory advertises a different one", () => {
    const result = reconcile({
      hosts: [listedHost("host", { devicePublicKey: "attacker-key" })],
      servers: [storedHost("host", { publicKey: "trusted-key", fingerprint: fingerprint("trusted-key") })],
    });

    expect(result.pinnedKeys).toEqual([{ hostId: "host", publicKey: "trusted-key" }]);
    expect(result.servers[0]?.publicKey).toBe("trusted-key");
  });

  it("adopts the advertised key for a host with nothing pinned yet", () => {
    const result = reconcile({ hosts: [listedHost("host")] });

    expect(result.pinnedKeys).toEqual([{ hostId: "host", publicKey: "host-key" }]);
    expect(result.servers[0]?.fingerprint).toBe(fingerprint("host-key"));
  });

  it("reports a host the directory dropped so the caller can disconnect it", () => {
    const result = reconcile({ hosts: [listedHost("kept")], servers: [storedHost("kept"), storedHost("revoked")] });

    expect(result.removedHostIds).toEqual(["revoked"]);
    expect(result.servers.map((server) => server.id)).toEqual(["kept"]);
  });

  it("leaves out this computer's own host and the hosts the user removed by hand", () => {
    const result = reconcile({
      hosts: [listedHost("self"), listedHost("hidden"), listedHost("wanted")],
      localHostId: "self",
      hidden: ["hidden"],
    });

    expect(result.servers.map((server) => server.id)).toEqual(["wanted"]);
  });

  it("treats the directory as the whole answer unless development invites are allowed", () => {
    const https = storedHost("https-server", { apiUrl: "https://api.example.com", transport: undefined });

    expect(reconcile({ servers: [https] }).servers).toEqual([]);
    expect(reconcile({ servers: [https], keepOtherTransports: true }).servers.map((server) => server.id)).toEqual([
      "https-server",
    ]);
  });

  it("refreshes the name and role the directory reports for a host already stored", () => {
    const result = reconcile({
      hosts: [listedHost("host", { name: "Renamed", role: "admin", logoKey: "logo-2" })],
      servers: [storedHost("host", { name: "Old name", role: "member", logoVersion: "logo-1" })],
    });

    expect(result.servers[0]).toMatchObject({ name: "Renamed", role: "admin", logoVersion: "logo-2" });
  });
});
