import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { createRemoteApiApp, prometheusMetrics } from "./app";
import { readRemoteApiConfig } from "./config";
import { SignalService } from "./signal-service";
import { RemoteTokenService, signServiceRequest } from "./tokens";

const config = readRemoteApiConfig();
const tokens = new RemoteTokenService(config, async (claims) => {
  const body = JSON.stringify(claims);
  const timestamp = Math.floor(Date.now() / 1_000).toString();
  const response = await fetch(new URL("/v2/remote/resume/validate", config.controlPlaneUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "OpenBot-Timestamp": timestamp,
      "OpenBot-Signature": signServiceRequest(body, timestamp, config.authWebhookSecret),
    },
    body,
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) return false;
  return z.object({ valid: z.boolean() }).parse(await response.json()).valid;
});
await tokens.initialize();
const signal = new SignalService(
  tokens,
  config.maximumConnectionsPerUser,
  config.maximumConnectionsPerIp,
  config.maximumMessagesPerMinute,
);
const tlsPaths =
  config.tlsCertificatePath && config.tlsPrivateKeyPath
    ? { certificate: config.tlsCertificatePath, privateKey: config.tlsPrivateKeyPath }
    : undefined;

const app = createRemoteApiApp(config, signal);
const listen = () =>
  app.listen({
    hostname: config.host,
    port: config.port,
    ...(tlsPaths
      ? {
          tls: {
            cert: Bun.file(tlsPaths.certificate),
            key: Bun.file(tlsPaths.privateKey),
          },
        }
      : {}),
  });
listen();
const healthServer = Bun.serve({
  hostname: "127.0.0.1",
  port: config.healthPort,
  routes: {
    "/health/live": () => Response.json({ service: "openbot-remote-api", status: "live" }),
    "/health/ready": () => Response.json({ service: "openbot-remote-api", status: "ready" }),
    "/metrics": (request) => {
      const authorization = request.headers.get("Authorization");
      if (!config.metricsToken || authorization !== `Bearer ${config.metricsToken}`)
        return new Response("Not found", { status: 404 });
      return new Response(prometheusMetrics(signal), { headers: { "Content-Type": "text/plain; version=0.0.4" } });
    },
  },
  fetch: () => new Response("Not found", { status: 404 }),
});

const protocol = tlsPaths ? "https" : "http";
console.log(`OpenBot Remote API is ready at ${protocol}://${config.host}:${config.port}`);

let certificateHash = await tlsCertificateHash();
let reloading = false;
const certificateTimer = setInterval(() => void reloadTlsWhenChanged(), 5 * 60_000);

async function reloadTlsWhenChanged(): Promise<void> {
  if (!tlsPaths || reloading) return;
  const nextHash = await tlsCertificateHash();
  if (!nextHash || nextHash === certificateHash) return;
  reloading = true;
  try {
    await app.stop(true);
    listen();
    certificateHash = nextHash;
    console.log("OpenBot Remote API reloaded its TLS certificate.");
  } finally {
    reloading = false;
  }
}

async function tlsCertificateHash(): Promise<string | null> {
  if (!config.tlsCertificatePath || !config.tlsPrivateKeyPath) return null;
  try {
    const [certificate, key] = await Promise.all([
      readFile(config.tlsCertificatePath),
      readFile(config.tlsPrivateKeyPath),
    ]);
    return createHash("sha256").update(certificate).update(key).digest("hex");
  } catch {
    return null;
  }
}

const shutdown = async () => {
  clearInterval(certificateTimer);
  healthServer.stop(true);
  await app.stop(true);
  process.exit(0);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
