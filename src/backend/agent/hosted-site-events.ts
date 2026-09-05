import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import {
  type HostedSiteConversationEventAction,
  type HostedSiteConversationEventDetails,
  type HostedSiteConversationEventStatus,
  type HostedSiteSummary,
  hostedSiteConversationEventText,
  isHostedSiteConversationEventUrl,
} from "@openbot/contracts/ipc";

export type HostedSiteMutationTool = "publish_site" | "replace_site" | "delete_site";

export function isHostedSiteMutationTool(value: string): value is HostedSiteMutationTool {
  return value === "publish_site" || value === "replace_site" || value === "delete_site";
}

export function hostedSiteAction(tool: HostedSiteMutationTool): HostedSiteConversationEventAction {
  if (tool === "publish_site") return "publish";
  if (tool === "replace_site") return "replace";
  return "delete";
}

export function hostedSiteTool(action: HostedSiteConversationEventAction): HostedSiteMutationTool {
  if (action === "publish") return "publish_site";
  if (action === "replace") return "replace_site";
  return "delete_site";
}

export function hostedSiteEventMessageId(operationId: string, status: HostedSiteConversationEventStatus): string {
  return `hosted-site-event:${operationId}:${status}`;
}

export function hostedSiteEventCommandId(
  agentId: string,
  operationId: string,
  status: HostedSiteConversationEventStatus,
): string {
  return `hosted-site-event:${agentId}:${operationId}:${status}`;
}

export function hostedSiteEventDetails(site: HostedSiteSummary, siteId = site.id): HostedSiteConversationEventDetails {
  const titleSource = site.title.trim() || site.hostname.trim() || "Hosted site";
  const title = titleSource.slice(0, 120).trim() || "Hosted site";
  const hostname = hostedSiteMarkerHostname(site.hostname);
  const url = hostname && isHostedSiteConversationEventUrl(site.url, hostname) ? site.url : null;
  const details: HostedSiteConversationEventDetails = {
    siteId: siteId.trim() && siteId.length <= INPUT_LIMITS.identifier ? siteId.trim() : null,
    title,
    hostname: url ? hostname : null,
    url,
  };
  hostedSiteConversationEventText(details);
  return details;
}

export function hostedSiteMarkerHostname(value: string): string | null {
  if (!value || value.length > INPUT_LIMITS.hostname || value !== value.toLowerCase()) return null;
  try {
    const parsed = new URL(`https://${value}`);
    return parsed.hostname === value && parsed.port === "" && value.endsWith(".openbot.site") ? value : null;
  } catch {
    return null;
  }
}
