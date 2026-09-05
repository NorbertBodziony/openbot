// The skill marketplace, and the skills installed into a workspace.

import { IPC_CHANNELS } from "@openbot/contracts/ipc";
import { type BrowserWindow, dialog, type OpenDialogOptions } from "electron";
import type { SkillMarketplaceService } from "../skill-marketplace-service";
import { handleTrusted } from "../trusted-ipc";
import { parseInstallSkill, parseMarketplaceSkillQuery, parseSubmitSkill, parseUninstallSkill } from "./app-inputs";
import { nullishPayload, stringPayload } from "./validation";

export interface SkillIpcDependencies {
  skills: SkillMarketplaceService;
  getMainWindow: () => BrowserWindow | null;
}

export function registerSkillIpcHandlers({ skills, getMainWindow }: SkillIpcDependencies): void {
  handleTrusted(IPC_CHANNELS.skillsList, nullishPayload(parseMarketplaceSkillQuery), (query) => skills.list(query));
  handleTrusted(IPC_CHANNELS.skillsGet, stringPayload("skillId"), (skillId) => skills.get(skillId));
  handleTrusted(IPC_CHANNELS.skillsListMine, () => skills.listMine());
  handleTrusted(IPC_CHANNELS.skillsChoosePackage, async () => {
    const mainWindow = getMainWindow();
    const options: OpenDialogOptions = {
      title: "Choose a skill folder or ZIP",
      properties: ["openFile", "openDirectory"],
      filters: [{ name: "Skill packages", extensions: ["zip"] }],
    };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    return result.canceled || !result.filePaths[0] ? null : skills.stage(result.filePaths[0]);
  });
  handleTrusted(IPC_CHANNELS.skillsSubmit, parseSubmitSkill, (submission) => skills.submit(submission));
  handleTrusted(IPC_CHANNELS.skillsListInstalled, stringPayload("agentId"), (agentId) => skills.listInstalled(agentId));
  handleTrusted(IPC_CHANNELS.skillsInstall, parseInstallSkill, (installation) => skills.install(installation));
  handleTrusted(IPC_CHANNELS.skillsUninstall, parseUninstallSkill, (removal) => skills.uninstall(removal));
}
