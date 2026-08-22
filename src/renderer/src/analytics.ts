import type {
  AgentModelId,
  AgentProviderId,
  AgentReasoningEffort,
  AppInfo,
  CentralAuthUser,
} from "@openbot/contracts/ipc";
import { OpenPanel, type OpenPanelOptions } from "@openpanel/web";

export const OPENPANEL_API_URL = "https://analytics.openbot.run/api";
const OPENPANEL_CLIENT_ID = "6c989975-87ef-4f0c-857e-ab449a65b5c2";

type ServerKind = "local" | "remote" | "unknown";
type Result = "succeeded" | "failed";

interface AgentProperties {
  provider: AgentProviderId;
  model: AgentModelId;
  reasoning_effort: AgentReasoningEffort;
  server_kind: ServerKind;
}

export interface DesktopAnalyticsEvents {
  desktop_app_opened: { setup_completed: boolean; signed_in: boolean };
  account_sign_in_started: { result: "code_sent" | "failed"; failure_code?: string };
  account_sign_in_completed: { result: Result; failure_code?: string };
  account_signed_out: Record<string, never>;
  onboarding_completed: { preferred_provider: AgentProviderId };
  agent_created: AgentProperties;
  agent_updated: { changed_fields: string[] };
  agent_deleted: Record<string, never>;
  message_sent: Partial<AgentProperties> & {
    channel: "agent" | "direct";
    attachment_count: number;
    is_reply: boolean;
    delivery_count: number;
  };
  turn_started: AgentProperties;
  turn_completed: AgentProperties & { status: string; duration_ms?: number };
  agent_input_requested: {
    kind: "prompt" | "approval";
    prompt_count?: number;
    has_secret_prompt?: boolean;
    approval_kind?: "command" | "file-change" | "permissions";
  };
  agent_input_resolved: {
    kind: "prompt" | "approval";
    decision: "answered" | "accept" | "decline";
  };
  queue_action: {
    action: "cancel" | "steer" | "edit" | "reorder" | "interrupt";
    result: Result;
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
    result: Result;
    server_kind?: ServerKind;
    role?: "admin" | "member";
    email_bound?: boolean;
  };
  browser_action: { action: "open" | "activate" | "close" | "show" | "hide"; result: Result };
  search_used: { scope: "global" | "agent"; result_count: number };
  remote_desktop_action: {
    action: "connect" | "disconnect" | "select_display";
    result: Result;
    transport?: "unknown" | "p2p" | "relay";
    failure_code?: string;
  };
  update_action: { action: "check" | "download" | "install"; result: Result; phase?: string };
  operation_failed: { area: string; failure_code: string };
}

type AnalyticsEventName = keyof DesktopAnalyticsEvents;
export type OpenPanelClient = Pick<OpenPanel, "setGlobalProperties" | "track" | "identify" | "clear">;

type ClientFactory = (options: OpenPanelOptions) => OpenPanelClient;

export function shouldEnableDesktopAnalytics(appInfo: AppInfo, productionBuild: boolean): boolean {
  return productionBuild && appInfo.variant === "production";
}

export class DesktopAnalytics {
  readonly #createClient: ClientFactory;
  readonly #productionBuild: boolean;
  #client: OpenPanelClient | null = null;

  constructor(
    createClient: ClientFactory = (options) => new OpenPanel(options),
    productionBuild = import.meta.env.PROD,
  ) {
    this.#createClient = createClient;
    this.#productionBuild = productionBuild;
  }

  configure(appInfo: AppInfo): boolean {
    if (this.#client || !shouldEnableDesktopAnalytics(appInfo, this.#productionBuild)) return this.#client !== null;
    try {
      const client = this.#createClient({
        apiUrl: OPENPANEL_API_URL,
        clientId: OPENPANEL_CLIENT_ID,
        trackScreenViews: false,
        trackOutgoingLinks: false,
        trackAttributes: false,
        sessionReplay: { enabled: false },
      });
      client.setGlobalProperties({
        __referrer: "",
        surface: "desktop",
        environment: "production",
        app_version: appInfo.version,
        platform: appInfo.platform,
      });
      this.#client = client;
      return true;
    } catch {
      return false;
    }
  }

  track<Name extends AnalyticsEventName>(name: Name, properties: DesktopAnalyticsEvents[Name]): void {
    this.#run(() => this.#client?.track(name, { ...properties }));
  }

  identify(user: Pick<CentralAuthUser, "id" | "email">): void {
    this.#run(() => this.#client?.identify({ profileId: user.id, email: user.email }));
  }

  clear(): void {
    this.#run(() => this.#client?.clear());
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
