import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { randomBytes, timingSafeEqual, X509Certificate } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import https from "node:https";
import { dirname, join } from "node:path";
import type { PeerCertificate } from "node:tls";
import type { RemoteDesktopDisplay, RemoteDesktopIceServer } from "@openbot/contracts/ipc";
import { z } from "zod";
import { stopOwnedProcess } from "./host-tunnel-runtime";
import type { RemoteDesktopRuntimePaths } from "./remote-desktop-runtime-artifact";

const MOONLIGHT_USER_HEADER = "X-OpenBot-Remote-User";
const MOONLIGHT_STREAMER_SLOTS = 4;
const SUNSHINE_HTTPS_PORT = 47_990;
const SUNSHINE_HTTP_PORT = 47_989;
const localAddressSchema = z.object({ address: z.string(), family: z.string(), port: z.number().int() });
const moonlightHostSchema = z.object({
  host_id: z.number().int(),
  paired: z.enum(["Paired", "NotPaired"]),
});
const moonlightHostsSchema = z.object({ hosts: z.array(moonlightHostSchema) });
const moonlightCreatedHostSchema = z.object({ host: moonlightHostSchema });
const moonlightAppsSchema = z.object({
  apps: z.array(z.object({ app_id: z.number().int(), title: z.string() })),
});
const moonlightRoleSchema = z.object({
  role: z.object({
    permissions: z.object({
      allow_transport_webrtc: z.boolean(),
      allow_transport_websockets: z.boolean(),
    }),
  }),
});
const moonlightPairMessageSchema = z.union([
  z.object({ Pin: z.string().min(1) }).transform(({ Pin }) => ({ kind: "pin" as const, pin: Pin })),
  z.object({ Paired: z.object({ host_id: z.number().int() }) }).transform(() => ({ kind: "paired" as const })),
  z.literal("PairError").transform(() => ({ kind: "error" as const })),
  z.literal("InternalServerError").transform(() => ({ kind: "error" as const })),
]);
const sunshineDisplaysSchema = z.object({
  displays: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) })),
});

interface MoonlightRequestInit {
  method?: "GET" | "POST";
  body?: string;
}

export interface SunshineMoonlightRuntimeState {
  baseUrl: string;
  hostId: number;
  hostIds: number[];
  desktopAppId: number;
  displays: RemoteDesktopDisplay[];
  selectedDisplayId: string | null;
}

interface SunshineMoonlightRuntimeOptions {
  paths: RemoteDesktopRuntimePaths;
  stateDirectory: string;
  platform: "darwin" | "win32";
  credentials: { username: string; password: string };
  getDisplays: () => RemoteDesktopDisplay[];
  getIceServers: () => Promise<RemoteDesktopIceServer[]>;
  spawnProcess?: typeof nodeSpawn;
  onDiagnostic?: (source: "sunshine" | "moonlight", message: string) => void;
}

export class SunshineMoonlightRuntime {
  readonly #options: SunshineMoonlightRuntimeOptions;
  readonly #spawn: typeof nodeSpawn;
  #sunshine: ChildProcess | null = null;
  #moonlight: ChildProcess | null = null;
  #iceServer: Server | null = null;
  #iceToken = "";
  #state: SunshineMoonlightRuntimeState | null = null;
  #selectedDisplayId: string | null = null;
  #starting: Promise<SunshineMoonlightRuntimeState> | null = null;

  constructor(options: SunshineMoonlightRuntimeOptions) {
    this.#options = options;
    this.#spawn = options.spawnProcess ?? nodeSpawn;
  }

  get state(): SunshineMoonlightRuntimeState | null {
    return this.#state ? { ...this.#state } : null;
  }

  async start(): Promise<SunshineMoonlightRuntimeState> {
    if (this.#state) return { ...this.#state };
    if (this.#starting) return this.#starting;
    this.#starting = this.#start();
    try {
      return await this.#starting;
    } finally {
      this.#starting = null;
    }
  }

  async selectDisplay(displayId: string): Promise<void> {
    this.#selectedDisplayId = displayId;
    if (!this.#state) return;
    await this.#writeSunshineConfig();
    if (this.#sunshine) await stopOwnedProcess(this.#sunshine);
    this.#sunshine = null;
    await this.#startSunshine();
    if (this.#state) this.#state = { ...this.#state, selectedDisplayId: displayId };
  }

  async stop(): Promise<void> {
    this.#state = null;
    await Promise.all([
      this.#moonlight ? stopOwnedProcess(this.#moonlight) : Promise.resolve(),
      this.#sunshine ? stopOwnedProcess(this.#sunshine) : Promise.resolve(),
    ]);
    this.#moonlight = null;
    this.#sunshine = null;
    const iceServer = this.#iceServer;
    this.#iceServer = null;
    if (iceServer) await new Promise<void>((resolve) => iceServer.close(() => resolve()));
    this.#iceToken = "";
  }

  async #start(): Promise<SunshineMoonlightRuntimeState> {
    await mkdir(this.#options.stateDirectory, { recursive: true, mode: 0o700 });
    await this.#writeSunshineConfig();
    const iceEndpoint = await this.#startIceServer();
    await this.#writeMoonlightConfig();
    await this.#writeIceHelper();
    await this.#setSunshineCredentials();
    await this.#startSunshine();
    const displays = await this.#getSunshineDisplays();
    if (!this.#selectedDisplayId || !displays.some((display) => display.id === this.#selectedDisplayId)) {
      this.#selectedDisplayId = displays.find((display) => display.primary)?.id ?? displays[0]?.id ?? null;
    }
    const moonlightPort = await reservePort();
    this.#startMoonlight(moonlightPort, iceEndpoint);
    await waitForHttp(`http://127.0.0.1:${moonlightPort}/api/authenticate`, {
      headers: { [MOONLIGHT_USER_HEADER]: moonlightSlotUser(1) },
    });
    this.#options.onDiagnostic?.("moonlight", "OpenBot: Moonlight Web is ready.\n");
    const paired = await this.#bootstrapMoonlight(moonlightPort);
    this.#state = {
      baseUrl: `http://127.0.0.1:${moonlightPort}`,
      ...paired,
      displays,
      selectedDisplayId: this.#selectedDisplayId,
    };
    return { ...this.#state };
  }

  async #writeSunshineConfig(): Promise<void> {
    const values = [
      "sunshine_name = OpenBot Remote Desktop",
      "upnp = disabled",
      "stream_audio = disabled",
      "origin_web_ui_allowed = pc",
      "address_family = ipv4",
      "bind_address = 127.0.0.1",
      `credentials_file = ${join(this.#options.stateDirectory, "sunshine-credentials.json")}`,
      `file_state = ${join(this.#options.stateDirectory, "sunshine-state.json")}`,
      `file_apps = ${join(this.#options.stateDirectory, "sunshine-apps.json")}`,
      `pkey = ${join(this.#options.stateDirectory, "sunshine-key.pem")}`,
      `cert = ${join(this.#options.stateDirectory, "sunshine-cert.pem")}`,
      `log_path = ${join(this.#options.stateDirectory, "sunshine.log")}`,
      ...(this.#selectedDisplayId ? [`output_name = ${this.#selectedDisplayId}`] : []),
    ];
    await Promise.all([
      writeFile(join(this.#options.stateDirectory, "sunshine.conf"), `${values.join("\n")}\n`, { mode: 0o600 }),
      writeFile(
        join(this.#options.stateDirectory, "sunshine-apps.json"),
        `${JSON.stringify({ env: {}, apps: [{ name: "Desktop", image_path: "desktop.png" }] }, null, 2)}\n`,
        { mode: 0o600 },
      ),
    ]);
  }

  async #writeMoonlightConfig(): Promise<void> {
    const config = {
      data_storage: {
        type: "json",
        path: join(this.#options.stateDirectory, "moonlight-data.json"),
        session_expiration_check_interval: { secs: 300, nanos: 0 },
      },
      webrtc: {
        ice_servers: [{ urls: ["stun:stun.cloudflare.com:3478"], username: "", credential: "" }],
        ice_server_script: join(
          this.#options.stateDirectory,
          this.#options.platform === "win32" ? "openbot-ice-helper.cmd" : "openbot-ice-helper.sh",
        ),
        port_range: { min: 40_000, max: 40_031 },
        nat_1to1: null,
        network_types: ["udp4", "udp6", "tcp4", "tcp6"],
        include_loopback_candidates: false,
      },
      web_server: {
        bind_address: "127.0.0.1:8080",
        certificate: null,
        url_path_prefix: "",
        session_cookie_secure: false,
        forwarded_header: { username_header: MOONLIGHT_USER_HEADER, auto_create_missing_user: true },
        first_login_create_admin: true,
        first_login_assign_global_hosts: true,
        default_user_id: null,
        default_role_id: null,
        session_cookie_expiration: { secs: 3600, nanos: 0 },
      },
      moonlight: { default_http_port: SUNSHINE_HTTP_PORT, pair_device_name: "OpenBot Remote Desktop" },
      streamer_path: this.#options.paths.moonlightStreamer,
      log: { level_filter: "Info", file_path: join(this.#options.stateDirectory, "moonlight.log"), dev_venator: false },
      default_settings: null,
    };
    await writeFile(
      join(this.#options.stateDirectory, "moonlight-config.json"),
      `${JSON.stringify(config, null, 2)}\n`,
      {
        mode: 0o600,
      },
    );
  }

  async #writeIceHelper(): Promise<void> {
    const path = join(
      this.#options.stateDirectory,
      this.#options.platform === "win32" ? "openbot-ice-helper.cmd" : "openbot-ice-helper.sh",
    );
    const contents =
      this.#options.platform === "win32"
        ? "@powershell.exe -NoProfile -NonInteractive -Command \"Invoke-RestMethod -Headers @{Authorization=('Bearer ' + $env:OPENBOT_ICE_HELPER_TOKEN)} -Uri $env:OPENBOT_ICE_HELPER_URL | ConvertTo-Json -Compress\"\r\n"
        : '#!/bin/sh\nexec /usr/bin/curl --fail --silent --show-error --header "Authorization: Bearer $OPENBOT_ICE_HELPER_TOKEN" "$OPENBOT_ICE_HELPER_URL"\n';
    await writeFile(path, contents, { mode: 0o700 });
    if (this.#options.platform !== "win32") await chmod(path, 0o700);
  }

  async #setSunshineCredentials(): Promise<void> {
    const configPath = join(this.#options.stateDirectory, "sunshine.conf");
    await runProcess(
      this.#spawn,
      this.#options.paths.sunshine,
      [configPath, "--creds", this.#options.credentials.username, this.#options.credentials.password],
      dirname(this.#options.paths.sunshine),
    );
  }

  async #startSunshine(): Promise<void> {
    this.#sunshine = this.#spawn(this.#options.paths.sunshine, [join(this.#options.stateDirectory, "sunshine.conf")], {
      cwd: dirname(this.#options.paths.sunshine),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#pipeDiagnostics(this.#sunshine, "sunshine");
    await waitForHttps(SUNSHINE_HTTPS_PORT, join(this.#options.stateDirectory, "sunshine-cert.pem"));
  }

  #startMoonlight(port: number, iceEndpoint: string): void {
    this.#moonlight = this.#spawn(
      this.#options.paths.moonlightWebServer,
      [
        "--config-path",
        join(this.#options.stateDirectory, "moonlight-config.json"),
        "--bind-address",
        `127.0.0.1:${port}`,
        "--forwarded-header",
        MOONLIGHT_USER_HEADER,
        "--streamer-path",
        this.#options.paths.moonlightStreamer,
        "run",
      ],
      {
        cwd: dirname(this.#options.paths.moonlightWebServer),
        env: {
          ...process.env,
          OPENBOT_ICE_HELPER_URL: iceEndpoint,
          OPENBOT_ICE_HELPER_TOKEN: this.#iceToken,
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    this.#pipeDiagnostics(this.#moonlight, "moonlight");
  }

  async #bootstrapMoonlight(port: number): Promise<{ hostId: number; hostIds: number[]; desktopAppId: number }> {
    const baseUrl = `http://127.0.0.1:${port}`;
    const hostIds: number[] = [];
    for (let slot = 1; slot <= MOONLIGHT_STREAMER_SLOTS; slot += 1) {
      const user = moonlightSlotUser(slot);
      const hosts = (await moonlightJson(baseUrl, "/api/hosts", moonlightHostsSchema, {}, user)).hosts;
      this.#options.onDiagnostic?.(
        "moonlight",
        `OpenBot: found ${hosts.length} local Moonlight hosts for streamer slot ${slot}.\n`,
      );
      let host = hosts.find((candidate) => Number.isInteger(candidate.host_id));
      if (!host) {
        const created = await moonlightJson(
          baseUrl,
          "/api/host",
          moonlightCreatedHostSchema,
          {
            method: "POST",
            body: JSON.stringify({ address: "127.0.0.1", http_port: SUNSHINE_HTTP_PORT }),
          },
          user,
        );
        host = created.host;
        this.#options.onDiagnostic?.(
          "moonlight",
          `OpenBot: created local host ${host.host_id} for streamer slot ${slot}.\n`,
        );
      }
      if (host.paired !== "Paired") {
        this.#options.onDiagnostic?.(
          "moonlight",
          `OpenBot: pairing local host ${host.host_id} for streamer slot ${slot}.\n`,
        );
        await this.#pairMoonlight(baseUrl, host.host_id, user);
      }
      await this.#assertEmbeddedPermissions(baseUrl, user);
      hostIds.push(host.host_id);
    }
    const apps = (
      await moonlightJson(baseUrl, `/api/apps?host_id=${hostIds[0]}`, moonlightAppsSchema, {}, moonlightSlotUser(1))
    ).apps;
    const desktop = apps.find((app) => app.title.toLowerCase() === "desktop") ?? apps[0];
    if (!desktop) throw new Error("Sunshine did not publish the Desktop application.");
    return { hostId: hostIds[0], hostIds, desktopAppId: desktop.app_id };
  }

  async #getSunshineDisplays(): Promise<RemoteDesktopDisplay[]> {
    const native = await sunshineJson(
      SUNSHINE_HTTPS_PORT,
      "/api/openbot/displays",
      this.#options.credentials,
      join(this.#options.stateDirectory, "sunshine-cert.pem"),
      sunshineDisplaysSchema,
    );
    const local = this.#options.getDisplays();
    if (native.displays.length === 0) return structuredClone(local);
    return native.displays.map((display, index) => {
      const metadata = local.find((candidate) => candidate.id === display.id) ?? local[index];
      return {
        id: display.id,
        label: metadata?.label ?? display.name,
        width: metadata?.width ?? 0,
        height: metadata?.height ?? 0,
        primary: metadata?.primary ?? index === 0,
      };
    });
  }

  async #pairMoonlight(baseUrl: string, hostId: number, user: string): Promise<void> {
    const body = JSON.stringify({ host_id: hostId });
    const response = await requestStream(
      `${baseUrl}/api/pair`,
      {
        [MOONLIGHT_USER_HEADER]: user,
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(body)),
      },
      body,
    );
    if (response.statusCode !== 200) {
      response.resume();
      throw new Error(`Moonlight pairing failed with HTTP ${response.statusCode ?? 0}.`);
    }
    let buffer = "";
    let pinSubmitted = false;
    for await (const chunk of response) {
      buffer += Buffer.from(chunk).toString("utf8");
      while (buffer.includes("\n")) {
        const newline = buffer.indexOf("\n");
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const message = moonlightPairMessageSchema.parse(JSON.parse(line));
        if (message.kind === "pin") {
          this.#options.onDiagnostic?.("moonlight", "OpenBot: received local pairing PIN.\n");
          // Moonlight publishes the PIN before its first pairing request reaches Sunshine.
          // A short delay prevents Sunshine from accepting the PIN before a pairing request exists.
          await new Promise((resolve) => setTimeout(resolve, 500));
          await sunshineRequest(
            SUNSHINE_HTTPS_PORT,
            "/api/pin",
            this.#options.credentials,
            join(this.#options.stateDirectory, "sunshine-cert.pem"),
            JSON.stringify({ pin: message.pin, name: "OpenBot Remote Desktop" }),
          );
          this.#options.onDiagnostic?.("moonlight", "OpenBot: submitted local pairing PIN.\n");
          pinSubmitted = true;
          continue;
        }
        if (message.kind === "paired") return;
        throw new Error("Moonlight rejected Sunshine pairing.");
      }
    }
    if (!pinSubmitted) throw new Error("Moonlight did not return a pairing PIN.");
    throw new Error("Moonlight pairing did not complete.");
  }

  async #assertEmbeddedPermissions(baseUrl: string, user: string): Promise<void> {
    const { role } = await moonlightJson(baseUrl, "/api/role", moonlightRoleSchema, {}, user);
    if (role.permissions.allow_transport_webrtc !== true || role.permissions.allow_transport_websockets !== false) {
      throw new Error("Moonlight Web is not an OpenBot embedded build.");
    }
  }

  async #startIceServer(): Promise<string> {
    if (this.#iceServer) {
      const address = localAddressSchema.safeParse(this.#iceServer.address());
      if (address.success) return `http://127.0.0.1:${address.data.port}/ice`;
    }
    this.#iceToken = randomBytes(32).toString("base64url");
    this.#iceServer = createServer((request, response) => {
      if (request.url !== "/ice" || request.headers.authorization !== `Bearer ${this.#iceToken}`) {
        response.writeHead(401).end();
        return;
      }
      void this.#options
        .getIceServers()
        .then((servers) => {
          response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          response.end(JSON.stringify(servers.map((server) => ({ ...server, urls: arrayUrls(server.urls) }))));
        })
        .catch(() => response.writeHead(503).end());
    });
    await new Promise<void>((resolve, reject) => {
      this.#iceServer?.once("error", reject);
      this.#iceServer?.listen(0, "127.0.0.1", resolve);
    });
    const address = localAddressSchema.parse(this.#iceServer.address());
    return `http://127.0.0.1:${address.port}/ice`;
  }

  #pipeDiagnostics(process: ChildProcess, source: "sunshine" | "moonlight"): void {
    for (const stream of [process.stdout, process.stderr]) {
      stream?.on("data", (chunk) => this.#options.onDiagnostic?.(source, chunk.toString("utf8")));
    }
  }
}

async function moonlightJson<T>(
  baseUrl: string,
  path: string,
  schema: z.ZodType<T>,
  init: MoonlightRequestInit = {},
  user = moonlightSlotUser(1),
): Promise<T> {
  const response = await moonlightHttpResponse(baseUrl, path, init, user);
  let buffer = "";
  for await (const chunk of response) {
    buffer += Buffer.from(chunk).toString("utf8");
    const newline = buffer.indexOf("\n");
    if (newline >= 0) {
      response.destroy();
      return schema.parse(JSON.parse(buffer.slice(0, newline)));
    }
  }
  if (!buffer.trim()) throw new Error("Moonlight returned an empty response.");
  return schema.parse(JSON.parse(buffer));
}

async function moonlightHttpResponse(
  baseUrl: string,
  path: string,
  init: MoonlightRequestInit,
  user: string,
): Promise<IncomingMessage> {
  const body = init.body ?? "";
  const headers: Record<string, string> = {
    [MOONLIGHT_USER_HEADER]: user,
    "Content-Type": "application/json",
    ...(body ? { "Content-Length": String(Buffer.byteLength(body)) } : {}),
  };
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = httpRequest(`${baseUrl}${path}`, { method: init.method ?? "GET", headers }, resolve);
    request.once("error", reject);
    request.end(body);
  });
  if (!response.statusCode || response.statusCode >= 300) {
    response.resume();
    throw new Error(`Moonlight API failed with HTTP ${response.statusCode ?? 0}.`);
  }
  return response;
}

async function sunshineRequest(
  port: number,
  path: string,
  credentials: { username: string; password: string },
  certificatePath: string,
  body: string,
): Promise<void> {
  const tls = await sunshineTlsOptions(certificatePath);
  await new Promise<void>((resolve, reject) => {
    const request = https.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        ...tls,
        auth: `${credentials.username}:${credentials.password}`,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      },
      (response) => {
        response.resume();
        response.on("end", () =>
          response.statusCode && response.statusCode < 300
            ? resolve()
            : reject(new Error(`Sunshine API failed with HTTP ${response.statusCode ?? 0}.`)),
        );
      },
    );
    request.once("error", reject);
    request.end(body);
  });
}

async function sunshineJson<T>(
  port: number,
  path: string,
  credentials: { username: string; password: string },
  certificatePath: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const tls = await sunshineTlsOptions(certificatePath);
  return new Promise<T>((resolve, reject) => {
    const request = https.get(
      {
        hostname: "127.0.0.1",
        port,
        path,
        ...tls,
        auth: `${credentials.username}:${credentials.password}`,
        headers: { Accept: "application/json" },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.once("error", reject);
        response.on("end", () => {
          if (!response.statusCode || response.statusCode >= 300) {
            reject(new Error(`Sunshine API failed with HTTP ${response.statusCode ?? 0}.`));
            return;
          }
          try {
            resolve(schema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.once("error", reject);
  });
}

async function requestStream(url: string, headers: Record<string, string>, body: string): Promise<IncomingMessage> {
  return new Promise<IncomingMessage>((resolve, reject) => {
    const request = httpRequest(url, { method: "POST", headers }, resolve);
    request.once("error", reject);
    request.end(body);
  });
}

async function waitForHttps(port: number, certificatePath: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const tls = await sunshineTlsOptions(certificatePath);
      await new Promise<void>((resolve, reject) => {
        const request = https.get({ hostname: "127.0.0.1", port, path: "/", ...tls }, (response) => {
          response.resume();
          resolve();
        });
        request.once("error", reject);
      });
      return;
    } catch {
      await shortDelay();
    }
  }
  throw new Error("Sunshine did not become ready.");
}

async function sunshineTlsOptions(certificatePath: string): Promise<{
  ca: Buffer;
  checkServerIdentity: (hostname: string, certificate: PeerCertificate) => Error | undefined;
}> {
  const ca = await readFile(certificatePath);
  const expected = new X509Certificate(ca).raw;
  return {
    ca,
    checkServerIdentity: (_hostname, certificate) => {
      const presented = certificate.raw;
      if (presented.length === expected.length && timingSafeEqual(presented, expected)) return undefined;
      return new Error("Sunshine returned an unexpected TLS certificate.");
    },
  };
}

async function waitForHttp(url: string, init: RequestInit): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, init);
      if (response.ok) return;
    } catch {
      // Retry while the local service starts.
    }
    await shortDelay();
  }
  throw new Error("Moonlight Web did not become ready.");
}

function shortDelay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 200));
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = localAddressSchema.parse(server.address());
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function runProcess(
  spawnProcess: typeof nodeSpawn,
  executable: string,
  args: string[],
  cwd?: string,
): Promise<void> {
  const child = spawnProcess(executable, args, { cwd, stdio: "ignore", windowsHide: true });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`Runtime setup exited with code ${code}.`)),
    );
  });
}

function arrayUrls(urls: string | string[]): string[] {
  return Array.isArray(urls) ? urls : [urls];
}

function moonlightSlotUser(slot: number): string {
  return `openbot-remote-slot-${slot}`;
}
