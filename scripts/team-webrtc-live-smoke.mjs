import { randomUUID } from "node:crypto";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app, BrowserWindow, safeStorage } from "electron";

app.setName("OpenBot");
await app.whenReady();

const bootstrap = await loadSmokeBootstrap();
const signalUrl = process.env.OPENBOT_REMOTE_SIGNAL_URL ?? bootstrap.signalUrl;
const hostTicket = process.env.OPENBOT_REMOTE_SMOKE_HOST_TICKET ?? bootstrap.hostTicket;
const clientTicket = process.env.OPENBOT_REMOTE_SMOKE_CLIENT_TICKET ?? bootstrap.clientTicket;
const iceTransportPolicy = process.env.OPENBOT_REMOTE_SMOKE_ICE_POLICY ?? "all";
const payloadBytes = Number(process.env.OPENBOT_REMOTE_SMOKE_BYTES ?? 100 * 1024 * 1024);

if (!hostTicket || !clientTicket) {
  console.error(
    "Set OPENBOT_REMOTE_SMOKE_HOST_TICKET and OPENBOT_REMOTE_SMOKE_CLIENT_TICKET to fresh tickets for the same host and session.",
  );
  process.exit(2);
}
if (iceTransportPolicy !== "all" && iceTransportPolicy !== "relay") {
  console.error("OPENBOT_REMOTE_SMOKE_ICE_POLICY must be all or relay.");
  process.exit(2);
}
if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 4 || payloadBytes > 100 * 1024 * 1024) {
  console.error("OPENBOT_REMOTE_SMOKE_BYTES must be an integer from 4 through 104857600.");
  process.exit(2);
}

const window = new BrowserWindow({
  show: false,
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  },
});

try {
  await window.loadURL("data:text/html,<meta charset=utf-8><title>OpenBot WebRTC smoke</title>");
  const result = await window.webContents.executeJavaScript(
    `(${runWebRtcSmoke.toString()})(${JSON.stringify({
      signalUrl,
      hostTicket,
      clientTicket,
      iceTransportPolicy,
      payloadBytes,
    })})`,
    true,
  );
  console.log(JSON.stringify({ status: "passed", ...result }));
  await bootstrap.cleanup();
  app.exit(0);
} catch (error) {
  await bootstrap.cleanup().catch(() => undefined);
  console.error(error instanceof Error ? error.stack : String(error));
  app.exit(1);
}

async function loadSmokeBootstrap() {
  const suppliedTickets =
    process.env.OPENBOT_REMOTE_SMOKE_HOST_TICKET && process.env.OPENBOT_REMOTE_SMOKE_CLIENT_TICKET;
  if (suppliedTickets) {
    return {
      signalUrl: "wss://signal.openbot.run/v1/signal",
      hostTicket: null,
      clientTicket: null,
      cleanup: async () => undefined,
    };
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error("System secret storage is unavailable for the live smoke.");
  const accountFile =
    process.env.OPENBOT_REMOTE_SMOKE_ACCOUNT_FILE ??
    join(app.getPath("appData"), "OpenBot", "openbot-central-auth-v1.bin");
  console.error("Remote smoke: loading the protected account session.");
  const encrypted = await readFile(accountFile, "utf8");
  const stored = JSON.parse(safeStorage.decryptString(Buffer.from(encrypted, "base64")));
  const apiUrl = process.env.OPENBOT_REMOTE_CONTROL_PLANE_URL ?? "https://api.openbot.run";
  const authorizedHeaders = { Authorization: `Bearer ${stored.sessionToken}` };
  console.error("Remote smoke: selecting a registered host.");
  const hostsResponse = await requestJson(new URL("/v2/remote/hosts/", apiUrl), { headers: authorizedHeaders });
  const hosts = Array.isArray(hostsResponse.hosts) ? hostsResponse.hosts : [];
  let host =
    hosts.find((candidate) => stored.teamHostTokens?.[candidate.hostId]) ??
    hosts.find((candidate) => candidate.role === "owner");
  let machineToken = host ? stored.teamHostTokens?.[host.hostId] : null;
  if (!host) {
    console.error("Remote smoke: registering the local host identity.");
    const localHost = JSON.parse(await readFile(join(dirname(accountFile), "openbot-team-server-v1.json"), "utf8"));
    const owner = localHost.members?.find((member) => member.role === "owner");
    if (!localHost.serverId || !localHost.serverName || !owner?.id) {
      throw new Error("The local Remote host identity is incomplete.");
    }
    const registration = await requestJson(new URL("/v2/remote/hosts/register", apiUrl), {
      method: "POST",
      headers: { ...authorizedHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        hostId: localHost.serverId,
        name: localHost.serverName,
        ownerMembershipId: owner.id,
        devicePublicKey: localHost.publicKey,
      }),
    });
    host = { ...registration, hostId: localHost.serverId };
    machineToken = registration.machineToken;
  }
  if (!machineToken) {
    console.error("Remote smoke: rotating the migrated host credential.");
    const registration = await requestJson(new URL("/v2/remote/hosts/register", apiUrl), {
      method: "POST",
      headers: { ...authorizedHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        hostId: host.hostId,
        name: host.name,
        ownerMembershipId: host.membershipId,
        devicePublicKey: host.devicePublicKey,
      }),
    });
    machineToken = registration.machineToken;
  }
  if (!machineToken) throw new Error("The Remote host credential is unavailable.");
  const normalizedHostId = host.hostId.toLowerCase();
  if (stored.teamHostTokens?.[normalizedHostId] !== machineToken) {
    stored.teamHostTokens = { ...stored.teamHostTokens, [normalizedHostId]: machineToken };
    const temporaryAccountFile = `${accountFile}.${randomUUID()}.tmp`;
    try {
      const protectedSession = safeStorage.encryptString(JSON.stringify(stored)).toString("base64");
      await writeFile(temporaryAccountFile, protectedSession, { mode: 0o600 });
      await chmod(temporaryAccountFile, 0o600);
      await rename(temporaryAccountFile, accountFile);
    } finally {
      await rm(temporaryAccountFile, { force: true });
    }
  }
  console.error("Remote smoke: creating temporary connection tickets.");
  const session = await requestJson(new URL("/v2/remote/sessions/", apiUrl), {
    method: "POST",
    headers: { ...authorizedHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ hostId: host.hostId }),
  });
  const hostBootstrap = await requestJson(
    new URL(`/v2/remote/hosts/${encodeURIComponent(host.hostId)}/ticket`, apiUrl),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ machineToken }),
    },
  );
  const clientBootstrap = await requestJson(
    new URL(`/v2/remote/sessions/${encodeURIComponent(session.sessionId)}/ticket`, apiUrl),
    {
      method: "POST",
      headers: { ...authorizedHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ clientPublicKey: "openbot-production-smoke-client" }),
    },
  );
  console.error("Remote smoke: starting Signal and WebRTC.");
  return {
    signalUrl: clientBootstrap.signalUrl,
    hostTicket: hostBootstrap.ticket,
    clientTicket: clientBootstrap.ticket,
    cleanup: async () => {
      await fetch(new URL(`/v2/remote/sessions/${encodeURIComponent(session.sessionId)}/end`, apiUrl), {
        method: "POST",
        headers: authorizedHeaders,
        signal: AbortSignal.timeout(10_000),
      });
    },
  };
}

async function requestJson(url, init) {
  let failure;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
      if (response.ok) return response.json();
      if (response.status < 500) throw new Error(`Remote control plane returned HTTP ${response.status}.`);
      failure = new Error(`Remote control plane returned HTTP ${response.status}.`);
    } catch (error) {
      failure = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
  }
  throw failure;
}

async function runWebRtcSmoke(input) {
  const timeoutMilliseconds = 30_000;
  const sockets = [];
  const connections = [];
  const failAfter = (label, milliseconds) =>
    new Promise((_, reject) => window.setTimeout(() => reject(new Error(`${label} timed out.`)), milliseconds));
  const withTimeout = (promise, label, milliseconds = timeoutMilliseconds) =>
    Promise.race([promise, failAfter(label, milliseconds)]);
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((nextResolve, nextReject) => {
      resolve = nextResolve;
      reject = nextReject;
    });
    return { promise, resolve, reject };
  };
  const openSignal = async (peer, token) => {
    const socket = new WebSocket(input.signalUrl);
    sockets.push(socket);
    const messages = [];
    const waiters = [];
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === "error") {
        const error = new Error(`Signal rejected ${peer}: ${message.code}.`);
        for (const waiter of waiters.splice(0)) waiter.reject(error);
        return;
      }
      messages.push(message);
      for (const waiter of [...waiters]) {
        if (!waiter.predicate(message)) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    };
    await withTimeout(
      new Promise((resolve, reject) => {
        socket.onopen = resolve;
        socket.onerror = () => reject(new Error(`Signal socket failed for ${peer}.`));
      }),
      `Signal connection for ${peer}`,
    );
    socket.send(JSON.stringify({ type: "hello", version: 1, peer, token }));
    return {
      socket,
      waitFor(predicate, label) {
        const existing = messages.find(predicate);
        if (existing) return Promise.resolve(existing);
        const result = deferred();
        waiters.push({ predicate, resolve: result.resolve, reject: result.reject });
        return withTimeout(result.promise, label);
      },
    };
  };
  const send = (signal, message) => signal.socket.send(JSON.stringify(message));
  const bindIce = (connection, signal, connectionId) => {
    connection.onicecandidate = (event) => {
      if (!event.candidate) return;
      send(signal, {
        type: "ice-candidate",
        version: 1,
        connectionId,
        channel: "team",
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex,
      });
    };
  };
  const selectedPath = async (connection) => {
    const stats = await connection.getStats();
    const transport = [...stats.values()].find(
      (report) => report.type === "transport" && report.selectedCandidatePairId,
    );
    const selectedPair = transport ? stats.get(transport.selectedCandidatePairId) : null;
    const pair =
      selectedPair ??
      [...stats.values()].find(
        (report) => report.type === "candidate-pair" && report.state === "succeeded" && report.nominated,
      ) ??
      [...stats.values()].find((report) => report.type === "candidate-pair" && report.state === "succeeded");
    if (pair) {
      const local = stats.get(pair.localCandidateId);
      const remote = stats.get(pair.remoteCandidateId);
      return {
        path: local?.candidateType === "relay" || remote?.candidateType === "relay" ? "relay" : "p2p",
        protocol: local?.protocol ?? "unknown",
        relayProtocol: local?.relayProtocol ?? null,
      };
    }
    throw new Error("WebRTC did not report a selected ICE pair.");
  };

  try {
    const hostSignal = await openSignal("host", input.hostTicket);
    const hostReady = await hostSignal.waitFor((message) => message.type === "ready", "Host ready");
    const clientSignal = await openSignal("client", input.clientTicket);
    const clientReady = await clientSignal.waitFor(
      (message) => message.type === "ready" && Boolean(message.connectionId),
      "Client ready",
    );
    const connectionId = clientReady.connectionId;
    await hostSignal.waitFor(
      (message) => message.type === "peer-ready" && message.connectionId === connectionId,
      "Host peer ready",
    );
    const iceServers = clientReady.iceServers?.length ? clientReady.iceServers : hostReady.iceServers;
    const client = new RTCPeerConnection({ iceServers, iceTransportPolicy: input.iceTransportPolicy });
    const host = new RTCPeerConnection({ iceServers, iceTransportPolicy: input.iceTransportPolicy });
    connections.push(client, host);
    bindIce(client, clientSignal, connectionId);
    bindIce(host, hostSignal, connectionId);
    for (const [connection, signal] of [
      [client, clientSignal],
      [host, hostSignal],
    ]) {
      signal.socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data));
        if (message.type !== "ice-candidate" || message.connectionId !== connectionId) return;
        void connection.addIceCandidate({
          candidate: message.candidate,
          sdpMid: message.sdpMid,
          sdpMLineIndex: message.sdpMLineIndex,
        });
      });
    }

    const hostChannel = deferred();
    host.ondatachannel = (event) => hostChannel.resolve(event.channel);
    const clientChannel = client.createDataChannel("openbot.team.rpc.v2", { ordered: true });
    const clientOpened = new Promise((resolve, reject) => {
      clientChannel.onopen = resolve;
      clientChannel.onerror = () => reject(new Error("Client DataChannel failed."));
    });
    const offer = await client.createOffer();
    await client.setLocalDescription(offer);
    send(clientSignal, {
      type: "offer",
      version: 1,
      connectionId,
      channel: "team",
      sdp: offer.sdp,
    });
    const relayedOffer = await hostSignal.waitFor(
      (message) => message.type === "offer" && message.connectionId === connectionId,
      "Relayed offer",
    );
    await host.setRemoteDescription({ type: "offer", sdp: relayedOffer.sdp });
    const answer = await host.createAnswer();
    await host.setLocalDescription(answer);
    send(hostSignal, {
      type: "answer",
      version: 1,
      connectionId,
      channel: "team",
      sdp: answer.sdp,
    });
    const relayedAnswer = await clientSignal.waitFor(
      (message) => message.type === "answer" && message.connectionId === connectionId,
      "Relayed answer",
    );
    await client.setRemoteDescription({ type: "answer", sdp: relayedAnswer.sdp });

    const receivedChannel = await withTimeout(hostChannel.promise, "Host DataChannel");
    await withTimeout(clientOpened, "Client DataChannel");
    const chunkBytes = 64 * 1024;
    let receivedBytes = 0;
    let receivedSequence = 0;
    const received = new Promise((resolve, reject) => {
      receivedChannel.binaryType = "arraybuffer";
      receivedChannel.onmessage = (event) => {
        const chunk = new Uint8Array(event.data);
        const sequence = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength).getUint32(0);
        if (sequence !== receivedSequence) return reject(new Error("DataChannel changed the chunk order."));
        receivedSequence += 1;
        receivedBytes += chunk.byteLength;
        if (receivedBytes === input.payloadBytes) resolve(receivedBytes);
        if (receivedBytes > input.payloadBytes) reject(new Error("DataChannel delivered excess file bytes."));
      };
      receivedChannel.onerror = () => reject(new Error("Host DataChannel failed."));
    });
    clientChannel.bufferedAmountLowThreshold = 1024 * 1024;
    let sentBytes = 0;
    let sequence = 0;
    while (sentBytes < input.payloadBytes) {
      if (clientChannel.bufferedAmount > 4 * 1024 * 1024) {
        await withTimeout(
          new Promise((resolve) => {
            const onLow = () => {
              clientChannel.removeEventListener("bufferedamountlow", onLow);
              resolve();
            };
            clientChannel.addEventListener("bufferedamountlow", onLow);
            if (clientChannel.bufferedAmount <= clientChannel.bufferedAmountLowThreshold) onLow();
          }),
          "DataChannel backpressure",
          120_000,
        );
      }
      const size = Math.min(chunkBytes, input.payloadBytes - sentBytes);
      const chunk = new Uint8Array(size);
      new DataView(chunk.buffer).setUint32(0, sequence);
      clientChannel.send(chunk);
      sentBytes += size;
      sequence += 1;
    }
    const delivered = await withTimeout(received, "DataChannel payload", 30 * 60_000);
    if (delivered !== input.payloadBytes) throw new Error("DataChannel changed the binary payload size.");
    const selected = await selectedPath(client);
    if (input.iceTransportPolicy === "relay" && selected.path !== "relay") {
      throw new Error("Relay-only smoke did not select TURN.");
    }
    return {
      signalUrl: input.signalUrl,
      iceTransportPolicy: input.iceTransportPolicy,
      ...selected,
      bytes: input.payloadBytes,
    };
  } finally {
    for (const connection of connections) connection.close();
    for (const socket of sockets) socket.close(1000, "Smoke completed");
  }
}
