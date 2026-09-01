import {
  AGENT_PROVIDERS,
  AGENT_REASONING_EFFORTS,
  type AgentEvent,
  type BotSummary,
  type CentralAuthUser,
  type ConversationMessage,
  hostedSiteConversationEvent,
  isAgentModel,
} from "@openbot/contracts/ipc";
import { isBoolean, isDynamicRecord, isFunction, isNumber, isOneOf, isString } from "@openbot/contracts/runtime-values";
import { normalizeEmailAddress } from "@openbot/contracts/validation";
import { OpenPanelBase, type OpenPanelOptions } from "@openpanel/web";

export const OPENPANEL_API_URL = "https://analytics.openbot.run/api";
export const OPENPANEL_CLIENT_ID = "6c989975-87ef-4f0c-857e-ab449a65b5c2";
const MAX_PENDING_EVENTS = 100;
const MAX_ACTIVE_TURNS = 1_000;
const MAX_HOSTED_SITE_OPERATIONS = 10_000;
const ACTIVE_TURN_TTL_MS = 24 * 60 * 60 * 1_000;
const ANALYTICS_SCHEMA_VERSION = 4;

type AnalyticsIdentity = Pick<CentralAuthUser, "id" | "email">;
type AnalyticsOperationKind = "clear" | "identify" | "track";
type AnalyticsOperation = { kind: AnalyticsOperationKind; run: () => unknown };
type AnalyticsOperationQueue = { active: boolean; operations: AnalyticsOperation[] };
type HostEventName =
  | "system_turn_started"
  | "system_turn_completed"
  | "system_agent_input_requested"
  | "system_operation_failed"
  | "hosted_site_action";
export type HostOpenPanelClient = Pick<OpenPanelBase, "setGlobalProperties" | "track" | "identify" | "clear">;
type ClientFactory = (options: OpenPanelOptions) => HostOpenPanelClient;

export interface HostAnalyticsOptions {
  enabled: boolean;
  trackingEnabled?: boolean;
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
  system_operation_failed: ["provider", "model", "reasoning_effort", "area", "failure_code"],
  hosted_site_action: ["action", "entry_point", "result", "failure_code"],
} as const satisfies Record<HostEventName, readonly string[]>;

type HostPropertyName = (typeof HOST_ALLOWLIST)[HostEventName][number];
type HostProperties = Partial<Record<HostPropertyName, string | number | boolean>>;
type HostPendingEvent = { name: HostEventName; properties: HostProperties; timestamp: string };
type ActiveTurn = { startedAt: number; origin: string };

export class HostAnalytics {
  readonly #resolveOwner: HostAnalyticsOptions["resolveOwner"];
  readonly #resolveBot: HostAnalyticsOptions["resolveBot"];
  readonly #client: HostOpenPanelClient | null;
  #identifiedOwner: AnalyticsIdentity | null = null;
  #trackingEnabled: boolean;
  #pending: HostPendingEvent[] = [];
  readonly #activeTurns = new Map<string, ActiveTurn>();
  readonly #hostedSiteOwners = new Map<string, AnalyticsIdentity | null>();
  readonly #hostedSiteTerminalOperations = new Set<string>();
  readonly #operationQueue: AnalyticsOperationQueue = { active: false, operations: [] };

  constructor(
    options: HostAnalyticsOptions,
    createClient: ClientFactory = (clientOptions) => new OpenPanelBase(clientOptions),
  ) {
    this.#resolveOwner = options.resolveOwner;
    this.#resolveBot = options.resolveBot;
    this.#trackingEnabled = options.trackingEnabled ?? true;
    if (!options.enabled) {
      this.#client = null;
      return;
    }
    try {
      const client = createClient({ apiUrl: OPENPANEL_API_URL, clientId: OPENPANEL_CLIENT_ID });
      client.setGlobalProperties({
        surface: "desktop_host",
        environment: "production",
        event_schema_version: ANALYTICS_SCHEMA_VERSION,
        app_version: options.appVersion,
        platform: options.platform,
      });
      this.#client = client;
    } catch {
      this.#client = null;
    }
  }

  handleAgentEvent(event: AgentEvent): void {
    if (event.type === "conversation" && this.#client) this.#handleHostedSiteConversation(event.snapshot.messages);
    if (!this.#client || !this.#trackingEnabled) return;
    switch (event.type) {
      case "conversation":
        return;
      case "turn-started": {
        const now = performance.now();
        this.#pruneActiveTurns(now);
        if (this.#activeTurns.has(event.turnId)) return;
        this.#makeTurnCapacity();
        this.#activeTurns.set(event.turnId, { startedAt: now, origin: event.origin ?? "unknown" });
        this.#track("system_turn_started", {
          ...this.#botProperties(event.botId),
          origin: event.origin ?? "unknown",
        });
        return;
      }
      case "turn-completed": {
        const activeTurn = this.#activeTurns.get(event.turnId);
        this.#activeTurns.delete(event.turnId);
        const origin =
          event.origin && event.origin !== "unknown" ? event.origin : (activeTurn?.origin ?? event.origin ?? "unknown");
        this.#track("system_turn_completed", {
          ...this.#botProperties(event.botId),
          origin,
          status: normalizedTurnStatus(event.status),
          ...(activeTurn === undefined
            ? {}
            : { duration_ms: Math.max(0, Math.round(performance.now() - activeTurn.startedAt)) }),
        });
        return;
      }
      case "prompt":
        this.#track("system_agent_input_requested", {
          ...this.#botProperties(event.botId),
          origin: this.#activeTurns.get(event.turnId)?.origin ?? "unknown",
          kind: "prompt",
          prompt_count: event.questions.length,
          has_secret_prompt: event.questions.some((question) => question.isSecret),
        });
        return;
      case "approval":
        this.#track("system_agent_input_requested", {
          ...this.#botProperties(event.approval.botId),
          origin: this.#activeTurns.get(event.approval.turnId)?.origin ?? "unknown",
          kind: "approval",
          approval_kind: event.approval.kind,
        });
        return;
      case "error":
        this.#track("system_operation_failed", {
          ...(event.botId ? this.#botProperties(event.botId) : {}),
          area: "agent",
          failure_code: systemFailureCode(event.code),
        });
        return;
      default:
        return;
    }
  }

  flushPending(): void {
    if (!this.#client || !this.#trackingEnabled) return;
    const owner = normalizeAnalyticsIdentity(this.#resolveOwner());
    if (!owner) return;
    this.#flushPendingForOwner(owner);
  }

  clear(): void {
    this.#pending = [];
    this.#activeTurns.clear();
    this.#identifiedOwner = null;
    this.#operationQueue.operations = [];
    if (this.#trackingEnabled) this.#enqueue("clear", () => this.#client?.clear());
  }

  setTrackingEnabled(enabled: boolean): void {
    if (this.#trackingEnabled === enabled) return;
    this.#trackingEnabled = enabled;
    if (!enabled) {
      this.clear();
      this.#enqueue("clear", () => this.#client?.clear());
      return;
    }
    this.flushPending();
  }

  #handleHostedSiteConversation(messages: readonly ConversationMessage[]): void {
    const events = messages.flatMap((message) => {
      const event = hostedSiteConversationEvent(message);
      return event ? [event] : [];
    });
    const terminalOperations = new Set(
      events.filter((event) => event.status !== "running").map((event) => event.operationId),
    );
    const observedRunningOperations = new Set(this.#hostedSiteOwners.keys());
    for (const event of events) {
      if (event.status === "running") {
        if (terminalOperations.has(event.operationId)) continue;
        const owner = normalizeAnalyticsIdentity(this.#resolveOwner());
        if (!this.#hostedSiteOwners.has(event.operationId)) this.#hostedSiteOwners.set(event.operationId, owner);
        continue;
      }
      if (!observedRunningOperations.has(event.operationId)) continue;
      if (this.#hostedSiteTerminalOperations.has(event.operationId)) continue;
      this.#hostedSiteTerminalOperations.add(event.operationId);
      const owner = this.#hostedSiteOwners.get(event.operationId) ?? null;
      this.#hostedSiteOwners.delete(event.operationId);
      if (!owner || !this.#trackingEnabled) continue;
      this.#trackForOwner(
        "hosted_site_action",
        {
          action: event.action,
          entry_point: "agent",
          result: event.status === "succeeded" ? "succeeded" : "failed",
          ...(event.status === "failed"
            ? { failure_code: "hosted_site_failed" }
            : event.status === "cancelled" || event.status === "interrupted"
              ? { failure_code: event.status }
              : {}),
        },
        owner,
        false,
      );
    }
    while (this.#hostedSiteOwners.size > MAX_HOSTED_SITE_OPERATIONS) {
      const oldest = this.#hostedSiteOwners.keys().next();
      if (oldest.done) break;
      this.#hostedSiteOwners.delete(oldest.value);
    }
    while (this.#hostedSiteTerminalOperations.size > MAX_HOSTED_SITE_OPERATIONS) {
      const oldest = this.#hostedSiteTerminalOperations.values().next();
      if (oldest.done) break;
      this.#hostedSiteTerminalOperations.delete(oldest.value);
    }
  }

  #trackForOwner(name: HostEventName, properties: HostProperties, owner: AnalyticsIdentity, flushPending = true): void {
    const sanitized = sanitizeHostEvent(name, properties);
    if (flushPending) this.#flushPendingForOwner(owner);
    else this.#identify(owner);
    this.#send(name, sanitized, owner.id);
    if (name === "hosted_site_action") {
      const currentOwner = normalizeAnalyticsIdentity(this.#resolveOwner());
      if (currentOwner?.id !== owner.id || currentOwner.email !== owner.email) {
        this.#enqueue("clear", () => this.#client?.clear());
      }
    }
  }

  #flushPendingForOwner(owner: AnalyticsIdentity): void {
    this.#identify(owner);
    const pending = this.#pending;
    this.#pending = [];
    for (const event of pending) this.#send(event.name, event.properties, owner.id, event.timestamp);
  }

  #track(name: HostEventName, properties: HostProperties): void {
    if (!this.#trackingEnabled) return;
    const sanitized = sanitizeHostEvent(name, properties);
    const owner = normalizeAnalyticsIdentity(this.#resolveOwner());
    if (!owner) {
      this.#pending.push({ name, properties: sanitized, timestamp: new Date().toISOString() });
      if (this.#pending.length > MAX_PENDING_EVENTS) this.#pending.shift();
      return;
    }
    this.#trackForOwner(name, sanitized, owner);
  }

  #identify(owner: AnalyticsIdentity): void {
    if (!this.#client) return;
    const previous = this.#identifiedOwner;
    if (previous?.id === owner.id && previous.email === owner.email) return;
    if (previous) this.#operationQueue.operations = [];
    if (previous && previous.id !== owner.id) this.#enqueue("clear", () => this.#client?.clear());
    this.#identifiedOwner = { ...owner };
    this.#enqueue("identify", () => this.#client?.identify({ profileId: owner.id, email: owner.email }));
  }

  #send(name: HostEventName, properties: HostProperties, profileId: string, timestamp?: string): void {
    this.#enqueue("track", () =>
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

  #pruneActiveTurns(now: number): void {
    for (const [turnId, turn] of this.#activeTurns) {
      if (now - turn.startedAt <= ACTIVE_TURN_TTL_MS) continue;
      this.#activeTurns.delete(turnId);
    }
  }

  #makeTurnCapacity(): void {
    while (this.#activeTurns.size >= MAX_ACTIVE_TURNS) {
      const oldestTurn = this.#activeTurns.keys().next();
      if (oldestTurn.done) return;
      this.#activeTurns.delete(oldestTurn.value);
    }
  }

  #enqueue(kind: AnalyticsOperationKind, run: () => unknown): void {
    if (kind === "clear") {
      this.#operationQueue.operations = this.#operationQueue.operations.filter(
        (operation) => operation.kind === "track",
      );
    } else if (kind === "identify") {
      this.#operationQueue.operations = this.#operationQueue.operations.filter(
        (operation) => operation.kind !== "identify",
      );
    } else if (
      this.#operationQueue.operations.filter((operation) => operation.kind === "track").length >= MAX_PENDING_EVENTS
    ) {
      const oldestTrack = this.#operationQueue.operations.findIndex((operation) => operation.kind === "track");
      if (oldestTrack >= 0) this.#operationQueue.operations.splice(oldestTrack, 1);
    }
    this.#operationQueue.operations.push({ kind, run });
    if (this.#operationQueue.active) return;
    this.#operationQueue.active = true;
    void this.#drainQueue();
  }

  async #drainQueue(): Promise<void> {
    while (this.#operationQueue.operations.length > 0) {
      const operation = this.#operationQueue.operations.shift();
      if (!operation) continue;
      try {
        const result = operation.run();
        if (isPromiseLike(result)) await result;
      } catch {
        // Analytics must never change host behavior or stop later events.
      }
    }
    this.#operationQueue.active = false;
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return isDynamicRecord(value) && isFunction(value.then);
}

function normalizeAnalyticsIdentity(user: AnalyticsIdentity | null): AnalyticsIdentity | null {
  if (!user) return null;
  const id = user.id.trim();
  const email = normalizeEmailAddress(user.email);
  return id && email ? { id, email } : null;
}

export function sanitizeHostEvent(name: HostEventName, properties: HostProperties): HostProperties {
  const allowed = HOST_ALLOWLIST[name];
  return Object.fromEntries(
    Object.entries(properties).flatMap(([key, value]) => {
      if (value === undefined || !allowed.some((item) => item === key)) return [];
      const safeValue = sanitizeHostProperty(name, key, value);
      return safeValue === undefined ? [] : [[key, safeValue]];
    }),
  );
}

function sanitizeHostProperty(name: HostEventName, key: string, value: unknown): string | number | boolean | undefined {
  if (key === "failure_code") {
    return isString(value)
      ? name === "hosted_site_action"
        ? hostedSiteFailureCode(value)
        : systemFailureCode(value)
      : "unknown";
  }
  if (name === "hosted_site_action") {
    if (key === "action") return isOneOf(["publish", "replace", "delete"] as const, value) ? value : undefined;
    if (key === "entry_point") return value === "agent" ? value : undefined;
    if (key === "result") return isOneOf(["succeeded", "failed"] as const, value) ? value : undefined;
  }
  if (key === "provider") return isOneOf(AGENT_PROVIDERS, value) ? value : undefined;
  if (key === "reasoning_effort") {
    return isOneOf(AGENT_REASONING_EFFORTS, value) ? value : undefined;
  }
  if (key === "model") return isAgentModel(value) ? value : undefined;
  if (key === "origin") {
    return isOneOf(["user", "routine", "bot", "unknown"] as const, value) ? value : undefined;
  }
  if (key === "status") return isString(value) ? normalizedTurnStatus(value) : undefined;
  if (key === "kind") return isOneOf(["prompt", "approval"] as const, value) ? value : undefined;
  if (key === "approval_kind") {
    return isOneOf(["command", "file-change", "permissions"] as const, value) ? value : undefined;
  }
  if (key === "area") return value === "agent" ? value : undefined;
  if (key === "prompt_count") {
    return isNumber(value) && Number.isInteger(value) && value >= 0 && value <= 100 ? value : undefined;
  }
  if (key === "duration_ms") {
    return isNumber(value) && Number.isFinite(value) && value >= 0 && value <= ACTIVE_TURN_TTL_MS ? value : undefined;
  }
  if (key === "has_secret_prompt") return isBoolean(value) ? value : undefined;
  return undefined;
}

function hostedSiteFailureCode(value: string): string {
  return value === "hosted_site_failed" || value === "cancelled" || value === "interrupted" ? value : "unknown";
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
