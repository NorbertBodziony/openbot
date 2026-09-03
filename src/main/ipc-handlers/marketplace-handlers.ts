import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { IPC_CHANNELS, isSkillCategory } from "@openbot/contracts/ipc";
import { isNumber, isString } from "@openbot/contracts/runtime-values";
import { type BrowserWindow, dialog, type OpenDialogOptions } from "electron";
import type { AgentService } from "../../backend/agent-service";
import type { BrowserHost } from "../../backend/browser-host";
import type { MailboxStore } from "../../backend/mailbox-store";
import type { AgentMarketplaceService } from "../agent-marketplace-service";
import type { HostedSiteDesktopService } from "../hosted-site-service";
import { parseUpdatePreference } from "../ipc/app-inputs";
import { parseAvatarImage } from "../ipc/avatar-inputs";
import { isObject, optionalBoolean, requireString } from "../ipc/validation";
import { exportDiagnostics, exportOpenBotData } from "../maintenance-service";
import type { SkillMarketplaceService } from "../skill-marketplace-service";
import { handleTrusted } from "../trusted-ipc";
import { readUpdatePreference, writeUpdatePreference } from "../update-preference-store";
import type { UpdateService } from "../update-service";

interface MarketplaceIpcDependencies {
  skills: SkillMarketplaceService;
  hostedSites: HostedSiteDesktopService;
  marketplaceAgents: AgentMarketplaceService;
  updater: UpdateService;
  updatePreferenceFile: string;
  service: AgentService;
  mailbox: MailboxStore;
  browser: BrowserHost;
  getMainWindow: () => BrowserWindow | null;
}

export function registerMarketplaceIpcHandlers({
  skills,
  hostedSites,
  marketplaceAgents,
  updater,
  updatePreferenceFile,
  service,
  mailbox,
  browser,
  getMainWindow,
}: MarketplaceIpcDependencies): void {
  handleTrusted(IPC_CHANNELS.skillsList, (input: unknown) => {
    if (input === null || input === undefined) return skills.list();
    if (!isObject(input)) throw new Error("Invalid marketplace query.");
    const category = input.category;
    if (category !== undefined && !isSkillCategory(category)) throw new Error("Unknown skill category.");
    if (input.sort !== undefined && input.sort !== "installs") throw new Error("Unknown skill sort order.");
    return skills.list({
      ...(isString(input.query) ? { query: input.query.slice(0, 100) } : {}),
      ...(category ? { category } : {}),
      ...(input.featured === true ? { featured: true } : {}),
      ...(input.sort === "installs" ? { sort: "installs" as const } : {}),
      ...(isString(input.cursor) ? { cursor: input.cursor } : {}),
      ...(isNumber(input.limit) ? { limit: input.limit } : {}),
    });
  });
  handleTrusted(IPC_CHANNELS.skillsGet, (input: unknown) => skills.get(requireString(input, "skillId")));
  handleTrusted(IPC_CHANNELS.skillsListMine, () => skills.listMine());
  handleTrusted(IPC_CHANNELS.skillsChoosePackage, async () => {
    const options: OpenDialogOptions = {
      title: "Choose a skill folder or ZIP",
      properties: ["openFile", "openDirectory"],
      filters: [{ name: "Skill packages", extensions: ["zip"] }],
    };
    const mainWindow = getMainWindow();
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    return result.canceled || !result.filePaths[0] ? null : skills.stage(result.filePaths[0]);
  });
  handleTrusted(IPC_CHANNELS.skillsSubmit, (input: unknown) => {
    if (!isObject(input) || !isSkillCategory(input.category)) throw new Error("Invalid skill submission.");
    return skills.submit({
      draftId: requireString(input.draftId, "draftId"),
      category: input.category,
      icon: parseAvatarImage(input.icon),
      ...(input.skillId === undefined ? {} : { skillId: requireString(input.skillId, "skillId") }),
    });
  });
  handleTrusted(IPC_CHANNELS.skillsListInstalled, (input: unknown) =>
    skills.listInstalled(requireString(input, "botId")),
  );
  handleTrusted(IPC_CHANNELS.skillsInstall, (input: unknown) => {
    if (!isObject(input)) throw new Error("Invalid skill installation.");
    return skills.install({
      botId: requireString(input.botId, "botId"),
      skillId: requireString(input.skillId, "skillId"),
      ...(input.replaceModified === true ? { replaceModified: true } : {}),
    });
  });
  handleTrusted(IPC_CHANNELS.skillsUninstall, (input: unknown) => {
    if (!isObject(input)) throw new Error("Invalid skill removal.");
    return skills.uninstall({
      botId: requireString(input.botId, "botId"),
      skillId: requireString(input.skillId, "skillId"),
      ...(input.removeModified === true ? { removeModified: true } : {}),
    });
  });
  handleTrusted(IPC_CHANNELS.hostedSitesList, () => hostedSites.list());
  handleTrusted(IPC_CHANNELS.hostedSitesChooseDirectory, async () => {
    const options: OpenDialogOptions = {
      title: "Choose a static site directory",
      properties: ["openDirectory"],
    };
    const mainWindow = getMainWindow();
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  handleTrusted(IPC_CHANNELS.hostedSitesPublish, (input: unknown) => {
    if (!isObject(input)) throw new Error("Invalid site publication.");
    const spaFallback = optionalBoolean(input.spaFallback, "spaFallback");
    return hostedSites.publish({
      sourcePath: requireString(input.sourcePath, "sourcePath", INPUT_LIMITS.path),
      title: requireString(input.title, "title", 120),
      description: requireString(input.description, "description", 500),
      ...(spaFallback !== undefined ? { spaFallback } : {}),
    });
  });
  handleTrusted(IPC_CHANNELS.hostedSitesReplace, (input: unknown) => {
    if (!isObject(input)) throw new Error("Invalid site replacement.");
    const spaFallback = optionalBoolean(input.spaFallback, "spaFallback");
    return hostedSites.replace({
      siteId: requireString(input.siteId, "siteId", INPUT_LIMITS.identifier),
      sourcePath: requireString(input.sourcePath, "sourcePath", INPUT_LIMITS.path),
      title: requireString(input.title, "title", 120),
      description: requireString(input.description, "description", 500),
      ...(spaFallback !== undefined ? { spaFallback } : {}),
    });
  });
  handleTrusted(IPC_CHANNELS.hostedSitesDelete, (input: unknown) => {
    if (!isObject(input)) throw new Error("Invalid site deletion.");
    return hostedSites.delete(requireString(input.siteId, "siteId", INPUT_LIMITS.identifier));
  });
  handleTrusted(IPC_CHANNELS.marketplaceAgentsList, (input: unknown) => {
    if (input === null || input === undefined) return marketplaceAgents.list();
    if (!isObject(input)) throw new Error("Invalid agent marketplace query.");
    if (input.sort !== undefined && input.sort !== "installs") throw new Error("Unknown agent sort order.");
    return marketplaceAgents.list({
      ...(isString(input.query) ? { query: input.query.slice(0, 100) } : {}),
      ...(input.featured === true ? { featured: true } : {}),
      ...(input.sort === "installs" ? { sort: "installs" as const } : {}),
      ...(isString(input.cursor) ? { cursor: input.cursor } : {}),
      ...(isNumber(input.limit) ? { limit: input.limit } : {}),
    });
  });
  handleTrusted(IPC_CHANNELS.marketplaceAgentsGet, (input: unknown) =>
    marketplaceAgents.get(requireString(input, "agentId")),
  );
  handleTrusted(IPC_CHANNELS.marketplaceAgentsListMine, () => marketplaceAgents.listMine());
  handleTrusted(IPC_CHANNELS.marketplaceAgentsPreview, (input: unknown) =>
    marketplaceAgents.preview(requireString(input, "botId")),
  );
  handleTrusted(IPC_CHANNELS.marketplaceAgentsSubmit, (input: unknown) => {
    if (!isObject(input)) throw new Error("Invalid agent submission.");
    return marketplaceAgents.submit({
      botId: requireString(input.botId, "botId"),
      ...(input.agentId === undefined ? {} : { agentId: requireString(input.agentId, "agentId") }),
    });
  });
  handleTrusted(IPC_CHANNELS.marketplaceAgentsInstall, (input: unknown) => {
    if (!isObject(input)) throw new Error("Invalid agent installation.");
    return marketplaceAgents.install({
      agentId: requireString(input.agentId, "agentId"),
      ...(input.botId === undefined ? {} : { botId: requireString(input.botId, "botId", INPUT_LIMITS.identifier) }),
      timezone: requireString(input.timezone, "timezone", 255),
      receiptId: requireString(input.receiptId, "receiptId", INPUT_LIMITS.identifier),
    });
  });
  handleTrusted(IPC_CHANNELS.updateGetStatus, () => updater.getStatus());
  handleTrusted(IPC_CHANNELS.updateCheck, () => updater.checkForUpdates());
  handleTrusted(IPC_CHANNELS.updateDownload, () => updater.downloadUpdate());
  handleTrusted(IPC_CHANNELS.updateInstall, () => updater.installUpdate());
  handleTrusted(IPC_CHANNELS.updateGetPreference, () => readUpdatePreference(updatePreferenceFile));
  handleTrusted(IPC_CHANNELS.updateSetPreference, async (input: unknown) => {
    const preference = await writeUpdatePreference(updatePreferenceFile, parseUpdatePreference(input).autoDownload);
    updater.setAutoDownload(preference.autoDownload);
    return preference;
  });
  handleTrusted(IPC_CHANNELS.maintenanceExportData, () =>
    exportOpenBotData({ service, mailbox, parentWindow: getMainWindow() }),
  );
  handleTrusted(IPC_CHANNELS.maintenanceExportDiagnostics, () =>
    exportDiagnostics({ service, browser, updater, parentWindow: getMainWindow() }),
  );
}
