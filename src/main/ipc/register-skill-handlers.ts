// The skill marketplace, and the skills installed into a workspace.

import { IPC_CHANNELS, isSkillCategory } from "@openbot/contracts/ipc";
import { isNumber, isString } from "@openbot/contracts/runtime-values";
import { type BrowserWindow, dialog, type OpenDialogOptions } from "electron";
import type { SkillMarketplaceService } from "../skill-marketplace-service";
import { handleTrusted } from "../trusted-ipc";
import { parseAvatarImage } from "./avatar-inputs";
import { isObject, requireString } from "./validation";

export interface SkillIpcDependencies {
  skills: SkillMarketplaceService;
  getMainWindow: () => BrowserWindow | null;
}

export function registerSkillIpcHandlers({ skills, getMainWindow }: SkillIpcDependencies): void {
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
}
