import {
  AGENT_PROVIDERS,
  AGENT_REASONING_EFFORTS,
  type AgentModelId,
  type AgentProviderId,
  type AgentReasoningEffort,
  type AppInfo,
  type CentralAuthUser,
  isAgentModel,
} from "@openbot/contracts/ipc";
import { isBoolean, isNumber, isString } from "@openbot/contracts/runtime-values";
import { OpenPanelBase, type OpenPanelOptions } from "@openpanel/web";

export const OPENPANEL_API_URL = "https://analytics.openbot.run/api";
export const OPENPANEL_CLIENT_ID = "6c989975-87ef-4f0c-857e-ab449a65b5c2";
const MAX_PENDING_EVENTS = 100;
export const ANALYTICS_SCHEMA_VERSION = 2;

export type ServerKind = "local" | "remote" | "unknown";
export type AnalyticsResult = "succeeded" | "failed";

export interface AgentAnalyticsProperties {
  provider: AgentProviderId;
  model: AgentModelId;
  reasoning_effort: AgentReasoningEffort;
  server_kind: ServerKind;
}

export interface DesktopAnalyticsEvents {
  desktop_app_opened: { setup_completed: boolean; signed_in: boolean };
  app_updated: { from_version: string; to_version: string };
  account_sign_in_started: { result: "code_sent" | "failed"; failure_code?: string };
  account_sign_in_completed: { result: AnalyticsResult; failure_code?: string };
  account_sign_out: { result: AnalyticsResult; failure_code?: string };
  onboarding_completed: { preferred_provider: AgentProviderId };
  agent_action:
    | ({ action: "create" } & Partial<AgentAnalyticsProperties> & {
          result: AnalyticsResult;
          failure_code?: string;
        })
    | (Partial<AgentAnalyticsProperties> & {
        action: "update";
        changed_fields: string[];
        result: AnalyticsResult;
        failure_code?: string;
      })
    | (Partial<AgentAnalyticsProperties> & {
        action: "delete";
        result: AnalyticsResult;
        failure_code?: string;
      });
  message_send: Partial<AgentAnalyticsProperties> & {
    channel: "agent" | "direct";
    attachment_count: number;
    is_reply: boolean;
    result: AnalyticsResult;
    delivery_count?: number;
    failure_code?: string;
  };
  agent_input_action: {
    kind: "prompt" | "approval";
    decision: "answered" | "accept" | "decline";
    result: AnalyticsResult;
    failure_code?: string;
  };
  queue_action: {
    action: "cancel" | "steer" | "edit" | "reorder" | "interrupt" | "stop";
    result: AnalyticsResult;
    failure_code?: string;
  };
  routine_action: {
    action: "create" | "update" | "delete" | "test";
    trigger_type: string;
    duration_ms: number;
    result: AnalyticsResult;
    failure_code?: string;
  };
  team_action: {
    action:
      | "server_selected"
      | "server_joined"
      | "identity_saved"
      | "published"
      | "unpublished"
      | "invite_created"
      | "member_updated"
      | "member_removed"
      | "invite_revoked";
    result: AnalyticsResult;
    server_kind?: ServerKind;
    role?: "admin" | "member";
    email_bound?: boolean;
    entry_point?: "in_app" | "invite_deep_link";
    failure_code?: string;
  };
  browser_action: {
    action: "open" | "activate" | "reload" | "close";
    result: AnalyticsResult;
    failure_code?: string;
  };
  search_action: {
    scope: "global" | "agent";
    result: AnalyticsResult;
    result_count?: number;
    failure_code?: string;
  };
  remote_desktop_action: {
    action: "connect" | "disconnect" | "select_display";
    result: AnalyticsResult;
    transport?: "unknown" | "p2p" | "relay";
    failure_code?: string;
  };
  update_action: {
    action: "check" | "download" | "install";
    result: AnalyticsResult;
    phase?: string;
    failure_code?: string;
  };
  marketplace_action: {
    entity: "skill" | "agent";
    action: "view" | "install" | "update" | "uninstall" | "publish";
    result: AnalyticsResult;
    failure_code?: string;
  };
  memory_action: {
    action: "create" | "update" | "delete" | "clear";
    result: AnalyticsResult;
    failure_code?: string;
  };
  provider_action: {
    provider?: AgentProviderId;
    action:
      | "connect_started"
      | "connect_completed"
      | "refresh"
      | "download_started"
      | "download_completed"
      | "download_cancelled";
    result: AnalyticsResult;
    failure_code?: string;
  };
  voice_transcription: {
    result: AnalyticsResult;
    audio_duration_seconds: number;
    duration_ms: number;
    failure_code?: string;
  };
  reaction_action: {
    action: "add" | "remove";
    result: AnalyticsResult;
    failure_code?: string;
  };
  maintenance_action: {
    action: "export_data" | "export_diagnostics";
    result: AnalyticsResult;
    failure_code?: string;
  };
}

export type AnalyticsEventName = keyof DesktopAnalyticsEvents;
export type OpenPanelClient = Pick<OpenPanelBase, "setGlobalProperties" | "track" | "identify" | "clear">;

type ClientFactory = (options: OpenPanelOptions) => OpenPanelClient;
type AnalyticsIdentity = Pick<CentralAuthUser, "id"> & Partial<Pick<CentralAuthUser, "email">>;
export interface DesktopAnalyticsScope {
  track<Name extends AnalyticsEventName>(name: Name, properties: DesktopAnalyticsEvents[Name]): void;
}

const EVENT_PROPERTY_ALLOWLIST = {
  desktop_app_opened: ["setup_completed", "signed_in"],
  app_updated: ["from_version", "to_version"],
  account_sign_in_started: ["result", "failure_code"],
  account_sign_in_completed: ["result", "failure_code"],
  account_sign_out: ["result", "failure_code"],
  onboarding_completed: ["preferred_provider"],
  agent_action: [
    "action",
    "provider",
    "model",
    "reasoning_effort",
    "server_kind",
    "changed_fields",
    "result",
    "failure_code",
  ],
  message_send: [
    "provider",
    "model",
    "reasoning_effort",
    "server_kind",
    "channel",
    "attachment_count",
    "is_reply",
    "result",
    "delivery_count",
    "failure_code",
  ],
  agent_input_action: ["kind", "decision", "result", "failure_code"],
  queue_action: ["action", "result", "failure_code"],
  routine_action: ["action", "trigger_type", "duration_ms", "result", "failure_code"],
  team_action: ["action", "result", "server_kind", "role", "email_bound", "entry_point", "failure_code"],
  browser_action: ["action", "result", "failure_code"],
  search_action: ["scope", "result", "result_count", "failure_code"],
  remote_desktop_action: ["action", "result", "transport", "failure_code"],
  update_action: ["action", "result", "phase", "failure_code"],
  marketplace_action: ["entity", "action", "result", "failure_code"],
  memory_action: ["action", "result", "failure_code"],
  provider_action: ["provider", "action", "result", "failure_code"],
  voice_transcription: ["result", "audio_duration_seconds", "duration_ms", "failure_code"],
  reaction_action: ["action", "result", "failure_code"],
  maintenance_action: ["action", "result", "failure_code"],
} as const satisfies Record<AnalyticsEventName, readonly string[]>;

type AnalyticsPropertyName = (typeof EVENT_PROPERTY_ALLOWLIST)[AnalyticsEventName][number];
type AnalyticsPropertyValue = string | number | boolean | readonly string[];
type SanitizedAnalyticsProperties = Partial<Record<AnalyticsPropertyName, AnalyticsPropertyValue>>;
type PendingEvent = {
  name: AnalyticsEventName;
  properties: SanitizedAnalyticsProperties;
  profileId: string | null;
  timestamp: string;
};

const SAFE_FAILURE_CODES = new Set([
  "auth_api_error",
  "avatar_update_failed",
  "browser_activate_failed",
  "browser_close_failed",
  "browser_open_failed",
  "browser_reload_failed",
  "cancel_failed",
  "check_failed",
  "clear_failed",
  "code_recently_sent",
  "connect_failed",
  "connection_failed",
  "create_failed",
  "delete_failed",
  "disconnect_failed",
  "display_select_failed",
  "download_failed",
  "edit_failed",
  "email_delivery_failed",
  "email_delivery_not_configured",
  "email_sign_in_failed",
  "email_sign_in_start_failed",
  "identity_save_failed",
  "install_failed",
  "interrupt_failed",
  "invalid_email",
  "invalid_sign_in_code",
  "invite_create_failed",
  "invite_revoke_failed",
  "join_failed",
  "load_failed",
  "member_remove_failed",
  "member_update_failed",
  "publish_failed",
  "rate_limited",
  "reaction_failed",
  "refresh_failed",
  "reorder_failed",
  "request_failed",
  "response_failed",
  "search_failed",
  "send_failed",
  "server_select_failed",
  "sign_in_code_expired",
  "sign_out_failed",
  "steer_failed",
  "too_many_code_attempts",
  "transcription_failed",
  "test_failed",
  "unauthorized",
  "uninstall_failed",
  "unknown",
  "unpublish_failed",
  "update_failed",
  "verification_failed",
]);

const EVENT_ACTIONS: Partial<Record<AnalyticsEventName, readonly string[]>> = {
  agent_action: ["create", "update", "delete"],
  agent_input_action: ["prompt", "approval"],
  queue_action: ["cancel", "steer", "edit", "reorder", "interrupt", "stop"],
  routine_action: ["create", "update", "delete", "test"],
  team_action: [
    "server_selected",
    "server_joined",
    "identity_saved",
    "published",
    "unpublished",
    "invite_created",
    "member_updated",
    "member_removed",
    "invite_revoked",
  ],
  browser_action: ["open", "activate", "reload", "close"],
  remote_desktop_action: ["connect", "disconnect", "select_display"],
  update_action: ["check", "download", "install"],
  marketplace_action: ["view", "install", "update", "uninstall", "publish"],
  memory_action: ["create", "update", "delete", "clear"],
  provider_action: [
    "connect_started",
    "connect_completed",
    "refresh",
    "download_started",
    "download_completed",
    "download_cancelled",
  ],
  reaction_action: ["add", "remove"],
  maintenance_action: ["export_data", "export_diagnostics"],
};

const CHANGED_FIELDS = new Map<string, string>([
  ["avatar", "avatar"],
  ["avatarHue", "avatar_hue"],
  ["avatarSeed", "avatar_seed"],
  ["description", "description"],
  ["model", "model"],
  ["name", "name"],
  ["notifications", "notifications"],
  ["provider", "provider"],
  ["reasoningEffort", "reasoning_effort"],
  ["title", "title"],
]);

const ROUTINE_TRIGGER_TYPES = new Set([
  "hourly",
  "daily",
  "weekdays",
  "weekly",
  "monthly",
  "interval",
  "advanced",
  "custom",
]);

const UPDATE_PHASES = new Set([
  "idle",
  "checking",
  "available",
  "downloading",
  "ready",
  "installing",
  "up-to-date",
  "error",
  "unsupported",
]);

export function shouldEnableDesktopAnalytics(appInfo: AppInfo, productionBuild: boolean): boolean {
  return productionBuild && appInfo.variant === "production";
}

export function sanitizeDesktopAnalyticsEvent(
  name: AnalyticsEventName,
  properties: DesktopAnalyticsEvents[AnalyticsEventName],
): SanitizedAnalyticsProperties {
  const allowed = EVENT_PROPERTY_ALLOWLIST[name];
  return Object.fromEntries(
    Object.entries(properties).flatMap(([key, value]) => {
      if (value === undefined || !allowed.some((item) => item === key)) return [];
      const safeValue = sanitizeDesktopProperty(name, key, value);
      return safeValue === undefined ? [] : [[key, safeValue]];
    }),
  );
}

function sanitizeDesktopProperty(
  name: AnalyticsEventName,
  key: string,
  value: unknown,
): AnalyticsPropertyValue | undefined {
  if (key === "failure_code") return isString(value) && SAFE_FAILURE_CODES.has(value) ? value : "unknown";
  if (key === "action") return safeEnum(value, EVENT_ACTIONS[name]);
  if (key === "result") {
    return safeEnum(value, name === "account_sign_in_started" ? ["code_sent", "failed"] : ["succeeded", "failed"]);
  }
  if (key === "provider" || key === "preferred_provider") return safeEnum(value, AGENT_PROVIDERS);
  if (key === "reasoning_effort") return safeEnum(value, AGENT_REASONING_EFFORTS);
  if (key === "model") return isAgentModel(value) ? value : undefined;
  if (key === "changed_fields") {
    if (!Array.isArray(value)) return undefined;
    return value.flatMap((item) => (isString(item) ? (CHANGED_FIELDS.get(item) ?? []) : [])).slice(0, 16);
  }
  if (key === "trigger_type") return isString(value) && ROUTINE_TRIGGER_TYPES.has(value) ? value : undefined;
  if (key === "phase") return isString(value) && UPDATE_PHASES.has(value) ? value : undefined;
  if (key === "from_version" || key === "to_version") {
    return isString(value) && /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u.test(value) ? value : undefined;
  }
  if (key === "attachment_count") return safeInteger(value, 0, 100);
  if (key === "delivery_count") return safeInteger(value, 0, 1_000);
  if (key === "result_count") return safeInteger(value, 0, 1_000_000);
  if (key === "duration_ms") return safeNumber(value, 0, 7 * 24 * 60 * 60 * 1_000);
  if (key === "audio_duration_seconds") return safeNumber(value, 0, 24 * 60 * 60);
  if (["setup_completed", "signed_in", "is_reply", "email_bound"].includes(key)) {
    return isBoolean(value) ? value : undefined;
  }
  const enumValues: Record<string, readonly string[] | undefined> = {
    channel: ["agent", "direct"],
    decision: ["answered", "accept", "decline"],
    entity: ["skill", "agent"],
    entry_point: ["in_app", "invite_deep_link"],
    kind: ["prompt", "approval"],
    role: ["admin", "member"],
    scope: ["global", "agent"],
    server_kind: ["local", "remote", "unknown"],
    transport: ["unknown", "p2p", "relay"],
  };
  return safeEnum(value, enumValues[key]);
}

function safeEnum(value: unknown, allowed: readonly string[] | undefined): string | undefined {
  return isString(value) && allowed?.includes(value) ? value : undefined;
}

function safeInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  return isNumber(value) && Number.isInteger(value) && value >= minimum && value <= maximum ? value : undefined;
}

function safeNumber(value: unknown, minimum: number, maximum: number): number | undefined {
  return isNumber(value) && Number.isFinite(value) && value >= minimum && value <= maximum ? value : undefined;
}

export class DesktopAnalytics {
  readonly #createClient: ClientFactory;
  readonly #productionBuild: boolean;
  #client: OpenPanelClient | null = null;
  #anonymousClient: OpenPanelClient | null = null;
  #disabled = false;
  #trackingEnabled = true;
  #identity: AnalyticsIdentity | null = null;
  #pending: PendingEvent[] = [];

  constructor(
    createClient: ClientFactory = (options) => new OpenPanelBase(options),
    productionBuild = import.meta.env.PROD,
  ) {
    this.#createClient = createClient;
    this.#productionBuild = productionBuild;
  }

  configure(appInfo: AppInfo): boolean {
    if (this.#client) return true;
    if (!shouldEnableDesktopAnalytics(appInfo, this.#productionBuild)) {
      this.#disabled = true;
      this.#pending = [];
      return false;
    }
    try {
      const clientOptions = {
        apiUrl: OPENPANEL_API_URL,
        clientId: OPENPANEL_CLIENT_ID,
      };
      const client = this.#createClient(clientOptions);
      const anonymousClient = this.#createClient(clientOptions);
      const globalProperties = {
        __referrer: "",
        surface: "desktop",
        environment: "production",
        event_schema_version: ANALYTICS_SCHEMA_VERSION,
        app_version: appInfo.version,
        platform: appInfo.platform,
      };
      client.setGlobalProperties(globalProperties);
      anonymousClient.setGlobalProperties(globalProperties);
      this.#client = client;
      this.#anonymousClient = anonymousClient;
      if (this.#trackingEnabled && this.#identity) this.#identifyClient(this.#identity);
      if (this.#trackingEnabled) this.#flush();
      return true;
    } catch {
      return false;
    }
  }

  setUser(user: AnalyticsIdentity | null): void {
    const previous = this.#identity;
    if (previous?.id === user?.id && previous?.email === user?.email) return;
    this.#identity = user ? { ...user } : null;
    if (!this.#client || !this.#trackingEnabled) return;
    if (previous) this.#run(() => this.#client?.clear());
    if (user) this.#identifyClient(user);
  }

  identify(user: AnalyticsIdentity): void {
    this.setUser(user);
  }

  clear(): void {
    this.setUser(null);
  }

  setTrackingEnabled(enabled: boolean): void {
    if (this.#trackingEnabled === enabled) return;
    this.#trackingEnabled = enabled;
    if (!enabled) {
      this.#pending = [];
      this.#run(() => this.#client?.clear());
      return;
    }
    if (this.#identity) this.#identifyClient(this.#identity);
  }

  scope(): DesktopAnalyticsScope {
    const profileId = this.#identity?.id ?? null;
    return {
      track: <Name extends AnalyticsEventName>(name: Name, properties: DesktopAnalyticsEvents[Name]) => {
        this.#track(name, properties, profileId);
      },
    };
  }

  anonymousScope(): DesktopAnalyticsScope {
    return {
      track: <Name extends AnalyticsEventName>(name: Name, properties: DesktopAnalyticsEvents[Name]) => {
        this.#track(name, properties, null);
      },
    };
  }

  track<Name extends AnalyticsEventName>(name: Name, properties: DesktopAnalyticsEvents[Name]): void {
    this.#track(name, properties, this.#identity?.id ?? null);
  }

  #track<Name extends AnalyticsEventName>(
    name: Name,
    properties: DesktopAnalyticsEvents[Name],
    profileId: string | null,
  ): void {
    if (this.#disabled || !this.#trackingEnabled) return;
    const sanitized = sanitizeDesktopAnalyticsEvent(name, properties);
    if (!this.#client) {
      this.#pending.push({ name, properties: sanitized, profileId, timestamp: new Date().toISOString() });
      if (this.#pending.length > MAX_PENDING_EVENTS) this.#pending.shift();
      return;
    }
    this.#send(name, sanitized, profileId);
  }

  #send(
    name: AnalyticsEventName,
    properties: SanitizedAnalyticsProperties,
    profileId: string | null,
    timestamp?: string,
  ): void {
    const client = profileId ? this.#client : this.#anonymousClient;
    this.#run(() =>
      client?.track(name, {
        ...properties,
        ...(timestamp ? { __timestamp: timestamp } : {}),
        ...(profileId ? { profileId } : {}),
      }),
    );
  }

  #flush(): void {
    const pending = this.#pending;
    this.#pending = [];
    for (const event of pending) {
      this.#send(event.name, event.properties, event.profileId, event.timestamp);
    }
  }

  #identifyClient(user: AnalyticsIdentity): void {
    this.#run(() => this.#client?.identify({ profileId: user.id }));
  }

  #run(operation: () => unknown): void {
    try {
      const result = operation();
      if (result instanceof Promise) void result.catch(() => undefined);
    } catch {
      // Analytics must never change application behavior.
    }
  }
}

export const desktopAnalytics = new DesktopAnalytics();
