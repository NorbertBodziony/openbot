import type { AgentEvent, BotSummary, CentralAuthUser } from "@openbot/contracts/ipc";
import { OpenPanelBase, type OpenPanelOptions } from "@openpanel/web";

export const OPENPANEL_API_URL = "https://analytics.openbot.run/api";
export const OPENPANEL_CLIENT_ID = "6c989975-87ef-4f0c-857e-ab449a65b5c2";
const MAX_PENDING_EVENTS = 100;

type AnalyticsIdentity = Pick<CentralAuthUser, "id" | "email">;
type HostEventName =
  | "system_turn_started"
  | "system_turn_completed"
  | "system_agent_input_requested"
  | "system_operation_failed";
export type HostOpenPanelClient = Pick<OpenPanelBase, "setGlobalProperties" | "track" | "identify" | "clear">;
type ClientFactory = (options: OpenPanelOptions) => HostOpenPanelClient;

export interface HostAnalyticsOptions {
  enabled: boolean;
  appVersion: string;
  platform: "darwin" | "win32" | "linux";
  resolveOwner: () => AnalyticsIdentity | null;
  resolveBot: (botId: string) => BotSummary | null;
}

const HOST_ALLOWLIST = {
  system_turn_started: ["provider", "model", "reasoning_effort", "origin"],
  system_turn_completed: ["provider", "model", "reasoning_effort", "origin", "status", "duration_ms"],
  system_agent_input_requested: [
    "provider",
    "model",
    "reasoning_effort",
    "origin",
    "kind",
    "prompt_count",
    "has_secret_prompt",
    "approval_kind",
  ],
  system_operation_failed: ["area", "failure_code"],
} as const satisfies Record<HostEventName, readonly string[]>;

type HostPropertyName = (typeof HOST_ALLOWLIST)[HostEventName][number];
type HostProperties = Partial<Record<HostPropertyName, string | number | boolean>>;
type HostPendingEvent = { name: HostEventName; properties: HostProperties; timestamp: string };

export class HostAnalytics {
  readonly #resolveOwner: HostAnalyticsOptions["resolveOwner"];
  readonly #resolveBot: HostAnalyticsOptions["resolveBot"];
  readonly #client: HostOpenPanelClient | null;
  #identifiedOwnerId: string | null = null;
  #pending: HostPendingEvent[] = [];
  readonly #turnStartedAt = new Map<string, number>();
  readonly #turnOrigins = new Map<string, string>();

  constructor(
    options: HostAnalyticsOptions,
    createClient: ClientFactory = (clientOptions) => new OpenPanelBase(clientOptions),
  ) {
    this.#resolveOwner = options.resolveOwner;
    this.#resolveBot = options.resolveBot;
    if (!options.enabled) {
      this.#client = null;
      return;
    }
    try {
      const client = createClient({ apiUrl: OPENPANEL_API_URL, clientId: OPENPANEL_CLIENT_ID });
      client.setGlobalProperties({
        surface: "desktop_host",
        environment: "production",
        app_version: options.appVersion,
        platform: options.platform,
      });
      this.#client = client;
    } catch {
      this.#client = null;
    }
  }

  handleAgentEvent(event: AgentEvent): void {
    if (!this.#client) return;
    switch (event.type) {
      case "turn-started": {
        this.#turnStartedAt.set(event.turnId, performance.now());
        this.#turnOrigins.set(event.turnId, event.origin ?? "unknown");
        this.#track("system_turn_started", {
          ...this.#botProperties(event.botId),
          origin: event.origin ?? "unknown",
        });
        return;
      }
      case "turn-completed": {
        const startedAt = this.#turnStartedAt.get(event.turnId);
        this.#turnStartedAt.delete(event.turnId);
        const origin = event.origin ?? this.#turnOrigins.get(event.turnId) ?? "unknown";
        this.#turnOrigins.delete(event.turnId);
        this.#track("system_turn_completed", {
          ...this.#botProperties(event.botId),
          origin,
          status: normalizedTurnStatus(event.status),
          ...(startedAt === undefined ? {} : { duration_ms: Math.max(0, Math.round(performance.now() - startedAt)) }),
        });
        return;
      }
      case "prompt":
        this.#track("system_agent_input_requested", {
          ...this.#botProperties(event.botId),
          origin: this.#turnOrigins.get(event.turnId) ?? "unknown",
          kind: "prompt",
          prompt_count: event.questions.length,
          has_secret_prompt: event.questions.some((question) => question.isSecret),
        });
        return;
      case "approval":
        this.#track("system_agent_input_requested", {
          ...this.#botProperties(event.approval.botId),
          origin: this.#turnOrigins.get(event.approval.turnId) ?? "unknown",
          kind: "approval",
          approval_kind: event.approval.kind,
        });
        return;
      case "error":
        this.#track("system_operation_failed", {
          area: "agent",
          failure_code: systemFailureCode(event.code),
        });
        return;
      default:
        return;
    }
  }

  flushPending(): void {
    if (!this.#client) return;
    const owner = this.#resolveOwner();
    if (!owner) return;
    this.#identify(owner);
    const pending = this.#pending;
    this.#pending = [];
    for (const event of pending) this.#send(event.name, event.properties, owner.id, event.timestamp);
  }

  #track(name: HostEventName, properties: HostProperties): void {
    const sanitized = sanitizeHostEvent(name, properties);
    const owner = this.#resolveOwner();
    if (!owner) {
      this.#pending.push({ name, properties: sanitized, timestamp: new Date().toISOString() });
      if (this.#pending.length > MAX_PENDING_EVENTS) this.#pending.shift();
      return;
    }
    this.#identify(owner);
    this.flushPending();
    this.#send(name, sanitized, owner.id);
  }

  #identify(owner: AnalyticsIdentity): void {
    if (!this.#client || this.#identifiedOwnerId === owner.id) return;
    if (this.#identifiedOwnerId) this.#run(() => this.#client?.clear());
    this.#identifiedOwnerId = owner.id;
    this.#run(() => this.#client?.identify({ profileId: owner.id, email: owner.email }));
  }

  #send(name: HostEventName, properties: HostProperties, profileId: string, timestamp?: string): void {
    this.#run(() =>
      this.#client?.track(name, {
        ...properties,
        ...(timestamp ? { __timestamp: timestamp } : {}),
        profileId,
      }),
    );
  }

  #botProperties(botId: string): HostProperties {
    const bot = this.#resolveBot(botId);
    return bot ? { provider: bot.provider, model: bot.model, reasoning_effort: bot.reasoningEffort } : {};
  }

  #run(operation: () => unknown): void {
    try {
      const result = operation();
      if (result instanceof Promise) void result.catch(() => undefined);
    } catch {
      // Analytics must never change host behavior.
    }
  }
}

export function sanitizeHostEvent(name: HostEventName, properties: HostProperties): HostProperties {
  const allowed = HOST_ALLOWLIST[name];
  const sanitized: HostProperties = Object.fromEntries(
    Object.entries(properties)
      .filter(([key, value]) => value !== undefined && allowed.some((item) => item === key))
      .map(([key, value]) => [key, key === "failure_code" ? systemFailureCode(String(value)) : value]),
  );
  return sanitized;
}

function normalizedTurnStatus(value: string): string {
  return ["completed", "failed", "interrupted", "cancelled"].includes(value) ? value : "other";
}

function systemFailureCode(value: string): string {
  switch (value) {
    case "context_compaction_failed":
    case "delivery_start_failed":
    case "delivery_turn_association_failed":
    case "interrupt_failed":
    case "memory_commit_failed":
    case "provider_history_backfill_pending":
    case "provider_metadata_refresh_failed":
    case "routine_delivery_failed":
    case "routine_delivery_recovery_failed":
    case "routine_scheduler_failed":
    case "server_request_failed":
      return value;
    default:
      if (/^(?:claude|codex|grok)_(?:diagnostic|exited|start_failed)$/u.test(value)) return value;
      if (value.startsWith("agent_")) return "agent_event_failed";
      return "unknown";
  }
}
