import { OpenPanel, type OpenPanelOptions } from "@openpanel/web";
import { OPENBOT_DOWNLOAD_LINKS, OPENBOT_LINKS } from "./landing-links";

export const OPENPANEL_API_URL = "https://analytics.openbot.run/api";
const OPENPANEL_CLIENT_ID = "6c989975-87ef-4f0c-857e-ab449a65b5c2";

interface LandingAnalyticsEvents {
  landing_viewed: Record<string, never>;
  landing_download_clicked: { platform: "macos" | "windows"; placement: LandingPlacement };
  landing_link_clicked: { destination: LandingDestination; placement: LandingPlacement };
  join_page_action: { action: "view" | "open_app" };
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

type OpenPanelClient = Pick<OpenPanel, "setGlobalProperties" | "track">;

type ClientFactory = (options: OpenPanelOptions) => OpenPanelClient;

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
  join_page_action: ["action"],
} as const satisfies Record<LandingEventName, readonly string[]>;

export function shouldEnableLandingAnalytics(hostname: string, productionBuild: boolean): boolean {
  return productionBuild && hostname === "openbot.run";
}

export class LandingAnalytics {
  readonly #createClient: ClientFactory;
  readonly #productionBuild: boolean;
  #client: OpenPanelClient | null = null;
  readonly #clickCleanup = new WeakMap<Document, () => void>();

  constructor(
    createClient: ClientFactory = (options) => new OpenPanel(options),
    productionBuild = import.meta.env.PROD,
  ) {
    this.#createClient = createClient;
    this.#productionBuild = productionBuild;
  }

  start(document: Document, hostname: string): () => void {
    if (!this.#ensureClient(hostname)) return () => undefined;
    this.#track("landing_viewed", {});
    const handleClick = (event: MouseEvent) => this.#handleClick(event);
    return this.#replaceClickListener(document, handleClick);
  }

  startJoin(document: Document, hostname: string): () => void {
    if (!this.#ensureClient(hostname)) return () => undefined;
    this.#track("join_page_action", { action: "view" });
    const handleClick = (event: MouseEvent) => {
      const target = event.target;
      const link = target instanceof Element ? target.closest<HTMLAnchorElement>("a[href]") : null;
      if (link?.getAttribute("href")?.startsWith("openbot://")) {
        this.#track("join_page_action", { action: "open_app" });
      }
    };
    return this.#replaceClickListener(document, handleClick);
  }

  #replaceClickListener(document: Document, listener: (event: MouseEvent) => void): () => void {
    this.#clickCleanup.get(document)?.();
    document.addEventListener("click", listener);
    const cleanup = () => {
      document.removeEventListener("click", listener);
      if (this.#clickCleanup.get(document) === cleanup) this.#clickCleanup.delete(document);
    };
    this.#clickCleanup.set(document, cleanup);
    return cleanup;
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
      client.setGlobalProperties({ __referrer: "", surface: "landing", environment: "production" });
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

  #track<Name extends LandingEventName>(name: Name, properties: LandingAnalyticsEvents[Name]): void {
    try {
      const allowed = EVENT_PROPERTY_ALLOWLIST[name];
      const sanitized = Object.fromEntries(
        Object.entries(properties).filter(
          ([key, value]) => value !== undefined && allowed.some((item) => item === key),
        ),
      );
      const result = this.#client?.track(name, sanitized);
      if (result instanceof Promise) void result.catch(() => undefined);
    } catch {
      // Analytics must never change landing-page behavior.
    }
  }
}

function landingPlacement(link: HTMLAnchorElement): LandingPlacement {
  if (link.closest(".landing-header")) return "header";
  if (link.closest(".landing-hero")) return "hero";
  if (link.closest(".landing-download")) return "download_section";
  if (link.closest(".landing-footer")) return "footer";
  return "other";
}

export const landingAnalytics = new LandingAnalytics();
