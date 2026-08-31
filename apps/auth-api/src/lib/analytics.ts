import { isBoolean, isOneOf } from "@openbot/contracts/runtime-values";
import { OpenPanel, OpenPanelBase, type OpenPanelOptions } from "@openpanel/web";
import { OPENBOT_DOWNLOAD_LINKS, OPENBOT_LINKS } from "./landing-links";

export const OPENPANEL_API_URL = "https://analytics.openbot.run/api";
const OPENPANEL_CLIENT_ID = "6c989975-87ef-4f0c-857e-ab449a65b5c2";
const ANALYTICS_SCHEMA_VERSION = 3;

export type LandingAcquisitionSource = "direct" | "search" | "social" | "github" | "other";

interface LandingAnalyticsEvents {
  landing_viewed: Record<string, never>;
  landing_download_clicked: { platform: "macos" | "windows"; placement: LandingPlacement };
  landing_link_clicked: { destination: LandingDestination; placement: LandingPlacement };
  join_page_action:
    | { action: "view"; valid_invite: boolean }
    | { action: "open_app" }
    | { action: "download"; platform: "macos" | "windows" };
}

type LandingEventName = keyof LandingAnalyticsEvents;
type LandingPlacement = "header" | "hero" | "download_section" | "footer" | "other";
type LandingDestination =
  | "download_section"
  | "contact"
  | "repository"
  | "releases"
  | "license"
  | "privacy"
  | "documentation"
  | "troubleshooting"
  | "architecture"
  | "contributing"
  | "codex"
  | "claude";

type LandingScreenPath = "/" | "/join";

type OpenPanelClient = Pick<OpenPanel, "setGlobalProperties" | "track"> & {
  trackScreenView: (path: LandingScreenPath) => ReturnType<OpenPanelBase["track"]>;
};

type ClientFactory = (options: OpenPanelOptions) => OpenPanelClient;

function createOpenPanelClient(options: OpenPanelOptions): OpenPanelClient {
  const client = new OpenPanel(options);
  return {
    setGlobalProperties: (properties) => client.setGlobalProperties(properties),
    track: (name, properties) => client.track(name, properties),
    trackScreenView: (path) => OpenPanelBase.prototype.track.call(client, "screen_view", { __path: path }),
  };
}

const LINK_DESTINATIONS = new Map<string, LandingDestination>([
  [OPENBOT_LINKS.download, "download_section"],
  [OPENBOT_LINKS.contact, "contact"],
  [OPENBOT_LINKS.repository, "repository"],
  [OPENBOT_LINKS.releases, "releases"],
  [OPENBOT_LINKS.license, "license"],
  [OPENBOT_LINKS.privacy, "privacy"],
  [OPENBOT_LINKS.documentation, "documentation"],
  [OPENBOT_LINKS.troubleshooting, "troubleshooting"],
  [OPENBOT_LINKS.architecture, "architecture"],
  [OPENBOT_LINKS.contributing, "contributing"],
  [OPENBOT_LINKS.codex, "codex"],
  [OPENBOT_LINKS.claude, "claude"],
]);

const EVENT_PROPERTY_ALLOWLIST = {
  landing_viewed: [],
  landing_download_clicked: ["platform", "placement"],
  landing_link_clicked: ["destination", "placement"],
  join_page_action: ["action", "valid_invite", "platform"],
} as const satisfies Record<LandingEventName, readonly string[]>;

export function shouldEnableLandingAnalytics(hostname: string, productionBuild: boolean): boolean {
  return productionBuild && hostname === "openbot.run";
}

export class LandingAnalytics {
  readonly #createClient: ClientFactory;
  readonly #productionBuild: boolean;
  #client: OpenPanelClient | null = null;
  #lastScreenPath: LandingScreenPath | null = null;
  readonly #clickCleanup = new WeakMap<Document, (replacement: boolean) => void>();

  constructor(createClient: ClientFactory = createOpenPanelClient, productionBuild = import.meta.env.PROD) {
    this.#createClient = createClient;
    this.#productionBuild = productionBuild;
  }

  start(document: Document, hostname: string): () => void {
    if (isLikelyAutomation(document.defaultView?.navigator)) return () => undefined;
    if (!this.#ensureClient(hostname)) return () => undefined;
    this.#client?.setGlobalProperties({ acquisition_source: landingAcquisitionSource(document) });
    this.#screenView("/");
    this.#track("landing_viewed", {});
    const handleClick = (event: MouseEvent) => this.#handleClick(event);
    return this.#replaceClickListener(document, handleClick, "/");
  }

  startJoin(
    document: Document,
    hostname: string,
    options: { validInvite: boolean; platform: "macos" | "windows" },
  ): () => void {
    if (isLikelyAutomation(document.defaultView?.navigator)) return () => undefined;
    if (!this.#ensureClient(hostname)) return () => undefined;
    this.#client?.setGlobalProperties({ acquisition_source: landingAcquisitionSource(document) });
    this.#screenView("/join");
    this.#track("join_page_action", { action: "view", valid_invite: options.validInvite });
    const handleClick = (event: MouseEvent) => {
      const target = event.target;
      const link = target instanceof Element ? target.closest<HTMLAnchorElement>("a[href]") : null;
      if (link?.getAttribute("href")?.startsWith("openbot://")) {
        this.#track("join_page_action", { action: "open_app" });
        return;
      }
      const href = link?.getAttribute("href");
      if (href === OPENBOT_DOWNLOAD_LINKS.macos || href === OPENBOT_DOWNLOAD_LINKS.windows) {
        this.#track("join_page_action", {
          action: "download",
          platform: href === OPENBOT_DOWNLOAD_LINKS.windows ? "windows" : "macos",
        });
      }
    };
    return this.#replaceClickListener(document, handleClick, "/join");
  }

  #replaceClickListener(
    document: Document,
    listener: (event: MouseEvent) => void,
    screenPath: LandingScreenPath,
  ): () => void {
    this.#clickCleanup.get(document)?.(true);
    document.addEventListener("click", listener);
    let cleaned = false;
    const cleanup = (replacement: boolean) => {
      if (cleaned) return;
      cleaned = true;
      document.removeEventListener("click", listener);
      if (this.#clickCleanup.get(document) === cleanup) this.#clickCleanup.delete(document);
      if (!replacement && this.#lastScreenPath === screenPath) this.#lastScreenPath = null;
    };
    this.#clickCleanup.set(document, cleanup);
    return () => cleanup(false);
  }

  #ensureClient(hostname: string): boolean {
    if (!shouldEnableLandingAnalytics(hostname, this.#productionBuild)) return false;
    if (this.#client) return true;
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
        surface: "landing",
        environment: "production",
        event_schema_version: ANALYTICS_SCHEMA_VERSION,
      });
      this.#client = client;
      return true;
    } catch {
      return false;
    }
  }

  #handleClick(event: MouseEvent): void {
    const target = event.target;
    const link = target instanceof Element ? target.closest<HTMLAnchorElement>("a[href]") : null;
    if (!link) return;
    const placement = landingPlacement(link);
    const href = link.getAttribute("href") ?? "";
    if (href === OPENBOT_DOWNLOAD_LINKS.macos) {
      this.#track("landing_download_clicked", { platform: "macos", placement });
      return;
    }
    if (href === OPENBOT_DOWNLOAD_LINKS.windows) {
      this.#track("landing_download_clicked", { platform: "windows", placement });
      return;
    }
    const destination = LINK_DESTINATIONS.get(href);
    if (destination) this.#track("landing_link_clicked", { destination, placement });
  }

  #screenView(path: LandingScreenPath): void {
    if (this.#lastScreenPath === path) return;
    try {
      const result = this.#client?.trackScreenView(path);
      if (result instanceof Promise) void result.catch(() => undefined);
      this.#lastScreenPath = path;
    } catch {
      // Analytics must never change landing-page behavior.
    }
  }

  #track<Name extends LandingEventName>(name: Name, properties: LandingAnalyticsEvents[Name]): void {
    try {
      const allowed = EVENT_PROPERTY_ALLOWLIST[name];
      const sanitized = Object.fromEntries(
        Object.entries(properties).filter(
          ([key, value]) =>
            value !== undefined && allowed.some((item) => item === key) && isSafeLandingProperty(name, key, value),
        ),
      );
      const result = this.#client?.track(name, sanitized);
      if (result instanceof Promise) void result.catch(() => undefined);
    } catch {
      // Analytics must never change landing-page behavior.
    }
  }
}

function isSafeLandingProperty(name: LandingEventName, key: string, value: unknown): boolean {
  if (key === "action") return isOneOf(["view", "open_app", "download"] as const, value);
  if (key === "valid_invite") return name === "join_page_action" && isBoolean(value);
  if (key === "platform") return value === "macos" || value === "windows";
  if (key === "placement") {
    return isOneOf(["header", "hero", "download_section", "footer", "other"] as const, value);
  }
  if (key === "destination") return [...LINK_DESTINATIONS.values()].some((destination) => destination === value);
  return false;
}

export function isLikelyAutomation(navigator: Pick<Navigator, "userAgent" | "webdriver"> | null | undefined): boolean {
  if (!navigator) return false;
  return navigator.webdriver || /(?:bot|crawler|spider|headless|lighthouse|preview)/iu.test(navigator.userAgent);
}

export function landingAcquisitionSource(document: Document): LandingAcquisitionSource {
  let campaignSource = "";
  try {
    campaignSource = new URL(document.location.href).searchParams.get("utm_source")?.toLowerCase() ?? "";
  } catch {
    // Invalid locations are treated as direct traffic.
  }
  const referrer = document.referrer.toLowerCase();
  const source = `${campaignSource} ${referrer}`;
  if (/github/u.test(source)) return "github";
  if (/(?:google|bing|duckduckgo|brave|yahoo)/u.test(source)) return "search";
  if (/(?:twitter|x\.com|linkedin|facebook|reddit|discord|social)/u.test(source)) return "social";
  return source.trim() ? "other" : "direct";
}

function landingPlacement(link: HTMLAnchorElement): LandingPlacement {
  if (link.closest(".landing-header")) return "header";
  if (link.closest(".landing-hero")) return "hero";
  if (link.closest(".landing-download")) return "download_section";
  if (link.closest(".landing-footer")) return "footer";
  return "other";
}

export const landingAnalytics = new LandingAnalytics();
