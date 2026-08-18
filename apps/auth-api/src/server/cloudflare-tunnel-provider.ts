import type { TeamTunnelProvider } from "./team-tunnel-service";

interface CloudflareResponse<T> {
  success: boolean;
  result: T;
  errors?: Array<{ code?: number; message?: string }>;
}

interface CloudflareTunnelProviderOptions {
  accountId: string;
  zoneId: string;
  apiToken: string;
  fetch?: typeof fetch;
}

export class CloudflareTunnelProvider implements TeamTunnelProvider {
  readonly #accountId: string;
  readonly #zoneId: string;
  readonly #apiToken: string;
  readonly #fetch: typeof fetch;

  constructor(options: CloudflareTunnelProviderOptions) {
    this.#accountId = requireIdentifier(options.accountId, "account");
    this.#zoneId = requireIdentifier(options.zoneId, "zone");
    if (!options.apiToken.trim()) throw new Error("The Cloudflare API token is missing.");
    this.#apiToken = options.apiToken;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async findTunnelId(name: string): Promise<string | null> {
    const query = new URLSearchParams({ name, is_deleted: "false" });
    const tunnels = await this.#request<Array<{ id?: string; name?: string }>>(
      `/accounts/${this.#accountId}/cfd_tunnel?${query}`,
    );
    const tunnel = tunnels.find((item) => item.name === name && isTunnelIdentifier(item.id));
    return tunnel?.id ?? null;
  }

  async createTunnel(name: string): Promise<string> {
    const tunnel = await this.#request<{ id?: string }>(`/accounts/${this.#accountId}/cfd_tunnel`, {
      method: "POST",
      body: { name, config_src: "cloudflare" },
    });
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
                service:
                  input.apiPort === null ? "http_status:503" : `http://127.0.0.1:${input.apiPort}`,
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
    );
  }

  async ensureDns(hostname: string, tunnelId: string): Promise<void> {
    const query = new URLSearchParams({ type: "CNAME", name: hostname });
    const records = await this.#request<
      Array<{ id?: string; type?: string; name?: string; content?: string; proxied?: boolean }>
    >(`/zones/${this.#zoneId}/dns_records?${query}`);
    const expectedContent = `${tunnelId}.cfargotunnel.com`;
    const existing = records.find((record) => record.name === hostname);
    if (existing) {
      if (
        existing.type !== "CNAME" ||
        existing.content !== expectedContent ||
        existing.proxied !== true
      ) {
        throw new CloudflareTunnelError("dns_hostname_conflict");
      }
      return;
    }
    await this.#request(`/zones/${this.#zoneId}/dns_records`, {
      method: "POST",
      body: {
        type: "CNAME",
        name: hostname,
        content: expectedContent,
        proxied: true,
        ttl: 1,
        comment: "Managed by OpenBot team hosting",
      },
    });
  }

  async getTunnelToken(tunnelId: string): Promise<string> {
    const token = await this.#request<unknown>(
      `/accounts/${this.#accountId}/cfd_tunnel/${tunnelId}/token`,
    );
    if (typeof token !== "string" || token.length < 40) {
      throw new CloudflareTunnelError("invalid_tunnel_token");
    }
    return token;
  }

  async deleteDns(hostname: string): Promise<void> {
    const query = new URLSearchParams({ name: hostname });
    const records = await this.#request<Array<{ id?: string; name?: string }>>(
      `/zones/${this.#zoneId}/dns_records?${query}`,
    );
    const record = records.find((item) => item.name === hostname && isIdentifier(item.id));
    if (record?.id) {
      await this.#request(`/zones/${this.#zoneId}/dns_records/${record.id}`, {
        method: "DELETE",
      });
    }
  }

  async deleteTunnel(tunnelId: string): Promise<void> {
    await this.#request(`/accounts/${this.#accountId}/cfd_tunnel/${tunnelId}`, {
      method: "DELETE",
    });
  }

  async #request<T>(
    path: string,
    options: { method?: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown } = {},
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
      console.error(
        "Cloudflare API request failed:",
        error instanceof Error ? error.message : "unknown_fetch_error",
      );
      throw new CloudflareTunnelError("cloudflare_unavailable");
    }
    let body: CloudflareResponse<T> | null = null;
    try {
      body = (await response.json()) as CloudflareResponse<T>;
    } catch {
      // Use the stable error below.
    }
    if (!response.ok || !body?.success) {
      throw new CloudflareTunnelError(
        response.status === 403 ? "cloudflare_permission_denied" : "cloudflare_api_error",
      );
    }
    return body.result;
  }
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
  return typeof value === "string" && /^[0-9a-f]{32}$/iu.test(value);
}

function isTunnelIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}
