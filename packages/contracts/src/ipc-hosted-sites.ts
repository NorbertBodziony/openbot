export type HostedSiteFramework = "vanilla" | "astro";
export type HostedSiteStatus = "active" | "deleted" | "expired" | "blocked";

export interface HostedSiteSummary {
  id: string;
  hostname: string;
  url: string;
  title: string;
  description: string;
  framework: HostedSiteFramework;
  status: HostedSiteStatus;
  fileCount: number;
  size: number;
  expiresAt: string | null;
  updatedAt: string;
}

export interface PublishHostedSiteInput {
  sourcePath: string;
  title: string;
  description: string;
  spaFallback?: boolean;
}

export interface ReplaceHostedSiteInput extends PublishHostedSiteInput {
  siteId: string;
}

export interface DeleteHostedSiteInput {
  siteId: string;
}
