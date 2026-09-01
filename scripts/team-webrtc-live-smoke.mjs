import { app, BrowserWindow } from "electron";

const signalUrl = process.env.OPENBOT_REMOTE_SIGNAL_URL ?? "wss://signal.openbot.run/v1/signal";
const hostTicket = process.env.OPENBOT_REMOTE_SMOKE_HOST_TICKET;
const clientTicket = process.env.OPENBOT_REMOTE_SMOKE_CLIENT_TICKET;
const iceTransportPolicy = process.env.OPENBOT_REMOTE_SMOKE_ICE_POLICY ?? "all";

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

await app.whenReady();
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
    `(${runWebRtcSmoke.toString()})(${JSON.stringify({ signalUrl, hostTicket, clientTicket, iceTransportPolicy })})`,
    true,
  );
  console.log(JSON.stringify({ status: "passed", ...result }));
  app.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  app.exit(1);
}

async function runWebRtcSmoke(input) {
  const timeoutMilliseconds = 30_000;
  const sockets = [];
  const connections = [];
  const failAfter = (label) =>
    new Promise((_, reject) => window.setTimeout(() => reject(new Error(`${label} timed out.`)), timeoutMilliseconds));
  const withTimeout = (promise, label) => Promise.race([promise, failAfter(label)]);
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
    for (const report of stats.values()) {
      if (report.type !== "candidate-pair" || report.state !== "succeeded" || !report.nominated) continue;
      const local = stats.get(report.localCandidateId);
      const remote = stats.get(report.remoteCandidateId);
      return local?.candidateType === "relay" || remote?.candidateType === "relay" ? "relay" : "p2p";
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
    const payload = crypto.getRandomValues(new Uint8Array(64 * 1024));
    const received = new Promise((resolve, reject) => {
      receivedChannel.binaryType = "arraybuffer";
      receivedChannel.onmessage = (event) => resolve(new Uint8Array(event.data));
      receivedChannel.onerror = () => reject(new Error("Host DataChannel failed."));
    });
    clientChannel.send(payload);
    const delivered = await withTimeout(received, "DataChannel payload");
    if (delivered.byteLength !== payload.byteLength || delivered.some((value, index) => value !== payload[index])) {
      throw new Error("DataChannel changed the binary payload.");
    }
    const path = await selectedPath(client);
    if (input.iceTransportPolicy === "relay" && path !== "relay") {
      throw new Error("Relay-only smoke did not select TURN.");
    }
    return {
      signalUrl: input.signalUrl,
      iceTransportPolicy: input.iceTransportPolicy,
      path,
      bytes: payload.byteLength,
    };
  } finally {
    for (const connection of connections) connection.close();
    for (const socket of sockets) socket.close(1000, "Smoke completed");
  }
}
