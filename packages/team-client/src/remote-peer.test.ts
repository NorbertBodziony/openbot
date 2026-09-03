import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import {
  encodeTeamProtocolV2Frame,
  TEAM_PROTOCOL_V2_CHANNELS,
  type TeamProtocolV2Json,
  teamProtocolV2AuthenticationTranscript,
} from "@openbot/contracts/team-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEd25519Identity, signEd25519 } from "./ed25519";
import { createRemoteTeamPeer, type RemoteTeamConnectionUpdate } from "./remote-peer";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("browser remote peer recovery", () => {
  it("does not create a session when unmounted before a queued connection starts", async () => {
    const network = await setupNetwork();
    const connecting = network.connect();
    await network.runtime.dispose();
    await expect(connecting).resolves.toMatchObject({ ok: false });
    expect(network.bootstraps()).toBe(0);
  });

  it.each(["disconnected", "failed", "closed"] as const)(
    "releases a %s peer and authenticates a fresh connection",
    async (state) => {
      const network = await setupNetwork();
      await expect(network.connect()).resolves.toMatchObject({ ok: true });
      network.connection().drop(state);
      expect(network.updates.at(-1)?.state).toBe("offline");
      await expect(network.connect()).resolves.toMatchObject({ ok: true });
      expect(network.connections).toHaveLength(2);
      expect(network.bootstraps()).toBe(2);
      await expect(
        network.runtime.execute({ id: "read", type: "request", method: "GET", path: "/v1/agents", body: {} }),
      ).resolves.toMatchObject({ ok: true, status: 200, body: [] });
      await network.runtime.dispose();
    },
  );

  it("does not reuse an authenticated peer whose browser missed the disconnect event", async () => {
    const network = await setupNetwork();
    await network.connect();
    network.connection().connectionState = "disconnected";
    await expect(network.connect()).resolves.toMatchObject({ ok: true });
    expect(network.connections).toHaveLength(2);
    await network.runtime.dispose();
  });

  it("detects a restarted desktop instead of reusing the old authenticated data channels", async () => {
    const network = await setupNetwork();
    await network.connect();
    const offline = deferred();
    network.onOffline = () => offline.resolve();
    network
      .socket()
      .receive({ type: "answer", version: 1, channel: "team", connectionId: "connection-1", sdp: sdp("CC:33") });
    await offline.promise;
    expect(network.updates.at(-1)?.state).toBe("offline");
    await expect(network.connect()).resolves.toMatchObject({ ok: true });
    expect(network.bootstraps()).toBe(2);
    await network.runtime.dispose();
  });

  it("suspends Signal reconnects in the background and resumes healthy data channels without a new ticket", async () => {
    // Fake only timers: network and cryptographic callbacks still run as ordinary microtasks.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const network = await setupNetwork();
    await network.connect();
    network.socket().close();
    network.runtime.setActive(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(network.sockets).toHaveLength(1);
    network.runtime.setActive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(network.sockets).toHaveLength(2);
    expect(network.bootstraps()).toBe(1);
    await network.runtime.dispose();
  });

  it("reports event-buffer loss so the workspace can reload cached conversations", async () => {
    const network = await setupNetwork();
    await network.connect();
    const reset = deferred();
    network.onReset = () => reset.resolve();
    network
      .connection()
      .channel(TEAM_PROTOCOL_V2_CHANNELS.events)
      .receive(encodeTeamProtocolV2Frame({ version: 2, type: "event-reset", nextSequence: 2001 }));
    await reset.promise;
    expect(network.updates.at(-1)).toMatchObject({ hostId: "host", resync: true });
    await network.runtime.dispose();
  });
});

function sdp(fingerprint: string) {
  return `v=0\r\na=fingerprint:sha-256 ${fingerprint}\r\n`;
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function setupNetwork() {
  const host = await createEd25519Identity(() => new Uint8Array(32).fill(7));
  const sockets: TestSocket[] = [];
  const connections: TestConnection[] = [];
  const updates: RemoteTeamConnectionUpdate[] = [];
  let bootstrapCount = 0;
  const callbacks = { onOffline: () => {}, onReset: () => {} };
  const connection = () => {
    const value = connections.at(-1);
    if (!value) throw new Error("No peer");
    return value;
  };
  const socket = () => {
    const value = sockets.at(-1);
    if (!value) throw new Error("No Signal socket");
    return value;
  };

  class TestSocket {
    static OPEN = 1;
    readyState = 1;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    constructor() {
      sockets.push(this);
      queueMicrotask(() => this.onopen?.());
    }
    receive(value: TeamProtocolV2Json) {
      this.onmessage?.({ data: JSON.stringify(value) });
    }
    send(data: string) {
      const message = JSON.parse(data);
      if (message.type === "hello")
        queueMicrotask(() =>
          this.receive({
            type: "ready",
            version: 1,
            connectionId: `connection-${bootstrapCount}`,
            resumeToken: "resume",
            iceServers: [{ urls: "stun:localhost" }],
          }),
        );
      if (message.type === "offer")
        queueMicrotask(() =>
          this.receive({
            type: "answer",
            version: 1,
            channel: "team",
            connectionId: message.connectionId,
            sdp: sdp("BB:22"),
          }),
        );
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
  }

  class TestChannel extends EventTarget {
    readyState = "connecting";
    bufferedAmount = 0;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(readonly label: string) {
      super();
    }
    receive(data: string) {
      this.onmessage?.({ data });
    }
    send(data: string) {
      const frame = JSON.parse(data);
      if (!isDynamicRecord(frame)) throw new Error("Invalid client frame");
      if (frame.type === "auth-init") {
        if (!isString(frame.ticket) || !isString(frame.clientPublicKey) || !isString(frame.clientNonce))
          throw new Error("Invalid auth");
        const clientNonce = frame.clientNonce;
        const hostNonce = "h".repeat(43);
        const transcript = teamProtocolV2AuthenticationTranscript({
          hostId: "host",
          sessionId: `session-${bootstrapCount}`,
          ticket: frame.ticket,
          clientPublicKey: frame.clientPublicKey,
          clientNonce,
          hostNonce,
          clientFingerprint: "AA:11",
          hostFingerprint: "BB:22",
        });
        void signEd25519(new TextEncoder().encode(transcript), host.secretKey).then((signature) =>
          this.receive(
            encodeTeamProtocolV2Frame({
              version: 2,
              type: "auth-ready",
              clientNonce,
              hostNonce,
              signature: btoa(String.fromCharCode(...signature))
                .replaceAll("+", "-")
                .replaceAll("/", "_")
                .replaceAll("=", ""),
            }),
          ),
        );
      } else if (frame.type === "auth-complete") {
        this.receive(JSON.stringify({ ...frame, type: "auth-confirmed" }));
      } else if (frame.type === "request") {
        this.receive(
          JSON.stringify({
            version: 2,
            type: "response",
            requestId: frame.requestId,
            result: { status: 200, body: [] },
          }),
        );
      }
    }
  }

  class TestConnection {
    connectionState = "new";
    localDescription: RTCSessionDescriptionInit | null = null;
    remoteDescription: RTCSessionDescriptionInit | null = null;
    onconnectionstatechange: (() => void) | null = null;
    readonly channels = new Map<string, TestChannel>();
    constructor() {
      connections.push(this);
    }
    channel(label: string) {
      const value = this.channels.get(label);
      if (!value) throw new Error("No channel");
      return value;
    }
    createDataChannel(label: string) {
      const value = new TestChannel(label);
      this.channels.set(label, value);
      return value;
    }
    async createOffer() {
      return { type: "offer", sdp: sdp("AA:11") };
    }
    async setLocalDescription(value: RTCSessionDescriptionInit) {
      this.localDescription = value;
    }
    async setRemoteDescription(value: RTCSessionDescriptionInit) {
      this.remoteDescription = value;
      this.connectionState = "connected";
      this.onconnectionstatechange?.();
      for (const channel of this.channels.values()) {
        channel.readyState = "open";
        channel.onopen?.();
      }
    }
    setConfiguration() {}
    restartIce() {}
    drop(state: string) {
      this.connectionState = state;
      this.onconnectionstatechange?.();
    }
    close() {
      this.drop("closed");
    }
  }

  vi.stubGlobal("WebSocket", TestSocket);
  vi.stubGlobal("RTCPeerConnection", TestConnection);
  const runtime = createRemoteTeamPeer({
    current: {
      getBootstrap: async () => {
        bootstrapCount += 1;
        return {
          sessionId: `session-${bootstrapCount}`,
          expiresAt: Date.now() + 60_000,
          signalUrl: "wss://signal",
          ticket: "ticket",
        };
      },
      endSession: async () => {},
      onTeamEvent: async () => {},
      onConnectionUpdate: async (update) => {
        updates.push(update);
        if (update.state === "offline") callbacks.onOffline();
        if (update.resync) callbacks.onReset();
      },
    },
  });
  return {
    runtime,
    sockets,
    connections,
    updates,
    connection,
    socket,
    bootstraps: () => bootstrapCount,
    connect: () =>
      runtime.execute({
        id: `connect-${bootstrapCount}`,
        type: "connect",
        hostId: "host",
        hostPublicKey: host.publicKeyPem,
      }),
    set onOffline(callback: () => void) {
      callbacks.onOffline = callback;
    },
    set onReset(callback: () => void) {
      callbacks.onReset = callback;
    },
  };
}
