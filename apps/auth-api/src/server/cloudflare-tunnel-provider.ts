import { type DynamicRecord, isBoolean, isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import type { TeamTunnelProvider } from "./team-tunnel-service";

interface CloudflareEnvelope {
  success: boolean;
  result: unknown;
}

interface CloudflareTunnelRecord {
  id?: string;
  name?: string;
}

interface CloudflareDnsRecord extends CloudflareTunnelRecord {
  type?: string;
  content?: string;
  proxied?: boolean;
}

type FetchRequest = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

interface CloudflareTunnelProviderOptions {
  accountId: string;
  zoneId: string;
  apiToken: string;
  fetch?: FetchRequest;
}

export class CloudflareTunnelProvider implements TeamTunnelProvider {
  readonly #accountId: string;
  readonly #zoneId: string;
  readonly #apiToken: string;
  readonly #fetch: FetchRequest;

  constructor(options: CloudflareTunnelProviderOptions) {
    this.#accountId = requireIdentifier(options.accountId, "account");
    this.#zoneId = requireIdentifier(options.zoneId, "zone");
    if (!options.apiToken.trim()) throw new Error("The Cloudflare API token is missing.");
    this.#apiToken = options.apiToken;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async findTunnelId(name: string): Promise<string | null> {
    const query = new URLSearchParams({ name, is_deleted: "false" });
    const tunnels = await this.#request(`/accounts/${this.#accountId}/cfd_tunnel?${query}`, {}, decodeTunnelRecords);
    const tunnel = tunnels.find((item) => item.name === name && isTunnelIdentifier(item.id));
    return tunnel?.id ?? null;
  }

  async createTunnel(name: string): Promise<string> {
    const tunnel = await this.#request(
      `/accounts/${this.#accountId}/cfd_tunnel`,
      { method: "POST", body: { name, config_src: "cloudflare" } },
      decodeTunnelRecord,
    );
    if (!isTunnelIdentifier(tunnel.id)) {
      throw new CloudflareTunnelError("invalid_tunnel_response");
    }
    return tunnel.id;
  }

  async configureTunnel(input: {
    tunnelId: string;
    apiHostname: string;
    vncHostname: string;
    apiPort: number | null;
    vncEnabled: boolean;
  }): Promise<void> {
    await this.#request(
      `/accounts/${this.#accountId}/cfd_tunnel/${input.tunnelId}/configurations`,
      {
        method: "PUT",
        body: {
          config: {
            ingress: [
              {
                hostname: input.apiHostname,
                service: input.apiPort === null ? "http_status:503" : `http://127.0.0.1:${input.apiPort}`,
                originRequest: {},
              },
              {
                hostname: input.vncHostname,
                service: "http_status:404",
                originRequest: {},
              },
              { service: "http_status:404" },
            ],
          },
        },
      },
      decodeRecordResult,
    );
  }

  async ensureDns(hostname: string, tunnelId: string): Promise<void> {
    const query = new URLSearchParams({ type: "CNAME", name: hostname });
    const records = await this.#request(`/zones/${this.#zoneId}/dns_records?${query}`, {}, decodeDnsRecords);
    const expectedContent = `${tunnelId}.cfargotunnel.com`;
    const existing = records.find((record) => record.name === hostname);
    if (existing) {
      if (existing.type !== "CNAME" || existing.content !== expectedContent || existing.proxied !== true) {
        throw new CloudflareTunnelError("dns_hostname_conflict");
      }
      return;
    }
    await this.#request(
      `/zones/${this.#zoneId}/dns_records`,
      {
        method: "POST",
        body: {
          type: "CNAME",
          name: hostname,
          content: expectedContent,
          proxied: true,
          ttl: 1,
          comment: "Managed by OpenBot team hosting",
        },
      },
      decodeRecordResult,
    );
  }

  async getTunnelToken(tunnelId: string): Promise<string> {
    const token = await this.#request(
      `/accounts/${this.#accountId}/cfd_tunnel/${tunnelId}/token`,
      {},
      decodeStringResult,
    );
    if (!isString(token) || token.length < 40) {
      throw new CloudflareTunnelError("invalid_tunnel_token");
    }
    return token;
  }

  async deleteDns(hostname: string): Promise<void> {
    const query = new URLSearchParams({ name: hostname });
    const records = await this.#request(`/zones/${this.#zoneId}/dns_records?${query}`, {}, decodeTunnelRecords);
    const record = records.find((item) => item.name === hostname && isIdentifier(item.id));
    if (record?.id) {
      await this.#request(`/zones/${this.#zoneId}/dns_records/${record.id}`, { method: "DELETE" }, decodeRecordResult);
    }
  }

  async deleteTunnel(tunnelId: string): Promise<void> {
    await this.#request(
      `/accounts/${this.#accountId}/cfd_tunnel/${tunnelId}`,
      { method: "DELETE" },
      decodeRecordResult,
    );
  }

  async #request<T>(
    path: string,
    options: { method?: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown } = {},
    decode: (value: unknown) => T,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetch(`https://api.cloudflare.com/client/v4${path}`, {
        method: options.method ?? "GET",
        headers: {
          Authorization: `Bearer ${this.#apiToken}`,
          Accept: "application/json",
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      console.error("Cloudflare API request failed:", error instanceof Error ? error.message : "unknown_fetch_error");
      throw new CloudflareTunnelError("cloudflare_unavailable");
    }
    let body: CloudflareEnvelope | null = null;
    try {
      body = decodeCloudflareEnvelope(await response.json());
    } catch {
      // Use the stable error below.
    }
    if (!response.ok || !body?.success) {
      throw new CloudflareTunnelError(
        response.status === 403 ? "cloudflare_permission_denied" : "cloudflare_api_error",
      );
    }
    return decode(body.result);
  }
}

function decodeCloudflareEnvelope(value: unknown): CloudflareEnvelope {
  if (!isDynamicRecord(value) || !isBoolean(value.success) || !("result" in value)) {
    throw new CloudflareTunnelError("invalid_cloudflare_response");
  }
  return { success: value.success, result: value.result };
}

function decodeTunnelRecord(value: unknown): CloudflareTunnelRecord {
  if (!isDynamicRecord(value)) throw new CloudflareTunnelError("invalid_tunnel_response");
  return {
    ...(isString(value.id) ? { id: value.id } : {}),
    ...(isString(value.name) ? { name: value.name } : {}),
  };
}

function decodeTunnelRecords(value: unknown): CloudflareTunnelRecord[] {
  if (!Array.isArray(value)) throw new CloudflareTunnelError("invalid_tunnel_response");
  return value.map(decodeTunnelRecord);
}

function decodeDnsRecords(value: unknown): CloudflareDnsRecord[] {
  if (!Array.isArray(value)) throw new CloudflareTunnelError("invalid_dns_response");
  return value.map((item) => {
    const record = decodeTunnelRecord(item);
    if (!isDynamicRecord(item)) throw new CloudflareTunnelError("invalid_dns_response");
    return {
      ...record,
      ...(isString(item.type) ? { type: item.type } : {}),
      ...(isString(item.content) ? { content: item.content } : {}),
      ...(isBoolean(item.proxied) ? { proxied: item.proxied } : {}),
    };
  });
}

function decodeRecordResult(value: unknown): DynamicRecord {
  if (!isDynamicRecord(value)) throw new CloudflareTunnelError("invalid_cloudflare_response");
  return value;
}

function decodeStringResult(value: unknown): string {
  if (!isString(value)) throw new CloudflareTunnelError("invalid_cloudflare_response");
  return value;
}

export class CloudflareTunnelError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function requireIdentifier(value: string, label: string): string {
  if (!isIdentifier(value)) throw new Error(`The Cloudflare ${label} ID is invalid.`);
  return value;
}

function isIdentifier(value: unknown): value is string {
  return isString(value) && /^[0-9a-f]{32}$/iu.test(value);
}

function isTunnelIdentifier(value: unknown): value is string {
  return isString(value) && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
