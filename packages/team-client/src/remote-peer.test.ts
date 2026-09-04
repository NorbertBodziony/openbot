import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import {
  encodeTeamProtocolV2Frame,
  TEAM_PROTOCOL_V2_CHANNELS,
  type TeamProtocolV2Json,
  teamProtocolV2AuthenticationTranscript,
} from "@openbot/contracts/team-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEd25519Identity, signEd25519 } from "./ed25519";
import {
  createRemoteCommandMailbox,
  createRemoteTeamPeer,
  type RemoteTeamCommand,
  type RemoteTeamConnectionUpdate,
} from "./remote-peer";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("browser remote peer recovery", () => {
  it("sends without delay when the data channel drains before the low-buffer listener is registered", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const network = await setupNetwork();
    await network.connect();
    try {
      const channel = network.connection().channel(TEAM_PROTOCOL_V2_CHANNELS.rpc);
      channel.bufferedAmount = 8 * 1024 * 1024;
      const register = channel.addEventListener.bind(channel);
      vi.spyOn(channel, "addEventListener").mockImplementation((type, listener, options) => {
        if (type === "bufferedamountlow") {
          channel.bufferedAmount = 0;
          channel.dispatchEvent(new Event("bufferedamountlow"));
        }
        register(type, listener, options);
      });
      let result: { ok: boolean } | undefined;
      const reading = network.runtime
        .execute({
          id: "drained-buffer",
          type: "request",
          method: "GET",
          path: "/v1/agents",
          body: {},
        })
        .then((value) => {
          result = value;
        });
      await vi.advanceTimersByTimeAsync(0);
      expect(result).toMatchObject({ ok: true, status: 200, body: [] });
      await reading;
    } finally {
      await network.runtime.dispose();
    }
  });

  it("rejects a malformed bootstrap response instead of leaving the bot loader pending forever", async () => {
    const network = await setupNetwork();
    await network.connect();
    const offline = deferred();
    network.onOffline = () => offline.resolve();
    let result: { ok: boolean } | undefined;
    // This fake host returns an array, which is not a compatibility document.
    const reading = network.runtime
      .execute({ id: "compatibility", type: "request", method: "GET", path: "/v1/compatibility", body: {} })
      .then((value) => {
        result = value;
      });
    await offline.promise;
    await vi.waitFor(() => expect(result).toMatchObject({ ok: false }));
    await reading;
    await network.runtime.dispose();
  });

  it.each(["initial-connect", "reconnect", "disconnect"] as const)(
    "waits for same-host session revocation before %s can bootstrap again",
    async (mode) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const cleanup = deferred();
      const initialOffer = deferred();
      const initialAnswer = deferred();
      let offered = false;
      let closingSession = false;
      const network = await setupNetwork({
        beforeAnswer: async () => {
          if (mode !== "initial-connect" || offered) return;
          offered = true;
          initialOffer.resolve();
          await initialAnswer.promise;
        },
        endSession: async () => {
          closingSession = true;
          await cleanup.promise;
          closingSession = false;
        },
        beforeBootstrap: async () => {
          // The directory reuses an active logical session. Bootstrapping during
          // its revocation would return a ticket for the session being ended.
          if (closingSession) throw new Error("The remote session ended.");
        },
      });
      const initial = network.connect();
      if (mode === "initial-connect") {
        await initialOffer.promise;
        network.connection().drop("failed");
        await expect(initial).resolves.toMatchObject({ ok: false });
        initialAnswer.resolve();
      } else await initial;
      const closed =
        mode === "disconnect" ? network.runtime.execute({ id: "disconnect", type: "disconnect" }) : Promise.resolve();
      if (mode === "reconnect") network.connection().drop("disconnected");
      const reconnecting = network.connect();
      await vi.advanceTimersByTimeAsync(0);
      cleanup.resolve();
      await closed;
      await expect(reconnecting).resolves.toMatchObject({ ok: true });
      await expect(
        network.runtime.execute({ id: "bots", type: "request", method: "GET", path: "/v1/agents", body: {} }),
      ).resolves.toMatchObject({ ok: true, status: 200, body: [] });
      await network.runtime.dispose();
    },
  );

  it("switches servers while an RPC and remote session cleanup are still pending", async () => {
    const cleanup = deferred();
    const network = await setupNetwork({ endSession: () => cleanup.promise });
    await network.connect();
    const oldConnection = network.connection();
    const pending = network.runtime.execute({
      id: "slow",
      type: "request",
      method: "GET",
      path: "/v1/agents/slow/conversation",
      body: {},
    });
    await network.slowRequest.promise;
    await expect(network.connect("other-host")).resolves.toMatchObject({ ok: true });
    await expect(pending).resolves.toMatchObject({ ok: false });
    expect(oldConnection.connectionState).toBe("closed");
    expect(network.updates.at(-1)).toMatchObject({ hostId: "other-host", state: "online" });
    cleanup.resolve();
    await network.runtime.dispose();
  });

  it("does not report an old canceled connection as offline after its replacement is online", async () => {
    const bootstrap = deferred();
    const started = deferred();
    const network = await setupNetwork({
      beforeBootstrap: async (hostId) => {
        if (hostId === "host") {
          started.resolve();
          await bootstrap.promise;
        }
      },
    });
    const old = network.connect();
    await started.promise;
    await expect(network.connect("other-host")).resolves.toMatchObject({ ok: true });
    bootstrap.resolve();
    await expect(old).resolves.toMatchObject({ ok: false });
    expect(network.updates.at(-1)).toMatchObject({ hostId: "other-host", state: "online" });
    await network.runtime.dispose();
  });
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

describe("native command mailbox", () => {
  it("keeps in-flight requests when a foreground refresh reuses the same host", async () => {
    const mailbox = createRemoteCommandMailbox(() => {});
    const connect = { id: "connect", type: "connect", hostId: "host", hostPublicKey: "key" } as const;
    const initial = mailbox.send(connect);
    mailbox.receive({ commandId: connect.id, ok: true });
    await initial;
    const reading = mailbox.send({ id: "read", type: "request", method: "GET", path: "/v1/agents", body: {} });
    const refresh = mailbox.send({ ...connect, id: "refresh" });
    mailbox.receive({ commandId: "refresh", ok: true });
    await refresh;
    mailbox.receive({ commandId: "read", ok: true, body: ["agent"] });
    await expect(reading).resolves.toMatchObject({ ok: true, body: ["agent"] });
  });
  it("delivers concurrent RPC results by ID instead of blocking behind a slow request", async () => {
    let published: RemoteTeamCommand[] = [];
    const mailbox = createRemoteCommandMailbox((commands) => {
      published = commands;
    });
    const slow = mailbox.send({ id: "slow", type: "request", method: "GET", path: "/slow", body: {} });
    const fast = mailbox.send({ id: "fast", type: "request", method: "GET", path: "/fast", body: {} });
    expect(published.map((command) => command.id)).toEqual(["slow", "fast"]);
    mailbox.receive({ commandId: "fast", ok: true, body: "fast response" });
    await expect(fast).resolves.toMatchObject({ body: "fast response" });
    mailbox.receive({ commandId: "slow", ok: true, body: "slow response" });
    await expect(slow).resolves.toMatchObject({ body: "slow response" });
    expect(published).toEqual([]);
  });

  it.each(["connect", "disconnect"] as const)(
    "%s preempts old commands and ignores their late results",
    async (type) => {
      let published: RemoteTeamCommand[] = [];
      const mailbox = createRemoteCommandMailbox((commands) => {
        published = commands;
      });
      const pending = mailbox.send({ id: "old", type: "request", method: "GET", path: "/slow", body: {} });
      const next = mailbox.send(
        type === "connect" ? { id: "next", type, hostId: "new-host", hostPublicKey: "key" } : { id: "next", type },
      );
      expect(published.map((command) => command.id)).toEqual(["next"]);
      await expect(pending).resolves.toMatchObject({ ok: false });
      mailbox.receive({ commandId: "old", ok: true, body: "stale" });
      expect(published.map((command) => command.id)).toEqual(["next"]);
      mailbox.receive({ commandId: "next", ok: true });
      await expect(next).resolves.toMatchObject({ ok: true });
      const abandoned = mailbox.send({ id: "abandoned", type: "request", method: "GET", path: "/slow", body: {} });
      mailbox.dispose();
      await expect(abandoned).resolves.toMatchObject({ ok: false });
    },
  );
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

async function setupNetwork(
  options: {
    endSession?: () => Promise<void>;
    beforeBootstrap?: (hostId: string) => Promise<void>;
    beforeAnswer?: () => Promise<void>;
  } = {},
) {
  const host = await createEd25519Identity(() => new Uint8Array(32).fill(7));
  const sockets: TestSocket[] = [];
  const connections: TestConnection[] = [];
  const updates: RemoteTeamConnectionUpdate[] = [];
  let bootstrapCount = 0;
  let currentHostId = "host";
  const slowRequest = deferred();
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
        queueMicrotask(async () => {
          await options.beforeAnswer?.();
          this.receive({
            type: "answer",
            version: 1,
            channel: "team",
            connectionId: message.connectionId,
            sdp: sdp("BB:22"),
          });
        });
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
          hostId: currentHostId,
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
        if (isDynamicRecord(frame.payload) && frame.payload.path === "/v1/agents/slow/conversation") {
          slowRequest.resolve();
          return;
        }
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
      getBootstrap: async (hostId) => {
        await options.beforeBootstrap?.(hostId);
        currentHostId = hostId;
        bootstrapCount += 1;
        return {
          sessionId: `session-${bootstrapCount}`,
          expiresAt: Date.now() + 60_000,
          signalUrl: "wss://signal",
          ticket: "ticket",
        };
      },
      endSession: options.endSession ?? (async () => {}),
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
    slowRequest,
    sockets,
    connections,
    updates,
    connection,
    socket,
    bootstraps: () => bootstrapCount,
    connect: (hostId = "host") =>
      runtime.execute({
        id: `connect-${bootstrapCount}`,
        type: "connect",
        hostId,
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
