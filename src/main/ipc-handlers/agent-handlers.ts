import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import {
  ATTACHMENT_FILE_EXTENSIONS,
  IMAGE_ATTACHMENT_EXTENSIONS,
  isSupportedAttachmentName,
  SUPPORTED_ATTACHMENT_DESCRIPTION,
} from "@openbot/contracts/attachment-files";
import { ATTACHMENT_LIMITS, INPUT_LIMITS } from "@openbot/contracts/input-limits";
import {
  type DuplicateBotResult,
  type FilePreview,
  type ImportAttachmentsInput,
  IPC_CHANNELS,
  type SendMessageInput,
  type SidebarLayoutSnapshot,
  type UpdateBotInput,
} from "@openbot/contracts/ipc";
import { app, type BrowserWindow, dialog, shell } from "electron";
import type { AgentService } from "../../backend/agent-service";
import type { MailboxStore } from "../../backend/mailbox-store";
import type { SidebarLayoutStore } from "../../backend/sidebar-layout-store";
import { filePreviewFromBytes, localFilePreview, mimeTypeForName } from "../file-preview";
import type { HostService } from "../host-service";
import {
  parseAcknowledgeFailedTurn,
  parseAgentRequest,
  parseApprovalResponse,
  parseBrowserTakeoverResponse,
  parseCancelQueuedMessage,
  parseChooseAttachments,
  parseCreateBot,
  parseCreateBotMemory,
  parseCreateRoutine,
  parseDeleteBotMemory,
  parseDeleteRoutine,
  parseImportAttachments,
  parseInterrupt,
  parseListRoutineRuns,
  parseMarkConversationRead,
  parseMessageReaction,
  parseOpenAttachment,
  parseOpenSharedFile,
  parseOpenWorkspaceFile,
  parsePromptResponse,
  parseReadConversationPage,
  parseReorderQueue,
  parseSearchConversationMessages,
  parseSendMessage,
  parseSetAgentAvatar,
  parseSidebarLayoutAction,
  parseSteerQueuedMessage,
  parseTestRoutine,
  parseUpdateBot,
  parseUpdateBotMemory,
  parseUpdateQueuedMessage,
  parseUpdateRoutine,
} from "../ipc/agent-inputs";
import { requireString } from "../ipc/validation";
import {
  decodeAccountUsage,
  decodeAgentModelOptions,
  decodeAgentStatus,
  decodeBotMemories,
  decodeBotMemory,
  decodeBotSummaries,
  decodeBotSummary,
  decodeInstalledSkills,
  decodeQueuedMessageReceipt,
  decodeQueueSnapshot,
  decodeRoutine,
  decodeRoutineRun,
  decodeRoutineRuns,
  decodeRoutines,
  decodeSidebarLayoutSnapshot,
  decodeVoid,
  type RemoteServerManager,
} from "../remote-server-manager";
import type { SkillMarketplaceService } from "../skill-marketplace-service";
import { handleTrusted } from "../trusted-ipc";

interface AgentIpcDependencies {
  service: AgentService;
  remoteServers: RemoteServerManager;
  sidebarLayout: SidebarLayoutStore;
  skills: SkillMarketplaceService;
  host: HostService;
  mailbox: MailboxStore;
  getMainWindow: () => BrowserWindow | null;
}

export function registerAgentIpcHandlers({
  service,
  remoteServers,
  sidebarLayout,
  skills,
  host,
  mailbox,
  getMainWindow,
}: AgentIpcDependencies): void {
  handleTrusted(IPC_CHANNELS.agentGetStatus, (input: unknown) => {
    const { serverId } = parseAgentRequest(input);
    return serverId === "local"
      ? service.getStatus()
      : remoteServers.request("/v1/agents/status", {}, serverId, decodeAgentStatus);
  });
  handleTrusted(IPC_CHANNELS.agentGetUsage, (input: unknown) => {
    const { serverId } = parseAgentRequest(input);
    return serverId === "local"
      ? service.getUsage()
      : remoteServers.request("/v1/agents/usage", {}, serverId, decodeAccountUsage);
  });
  handleTrusted(IPC_CHANNELS.agentListModels, (input: unknown) => {
    const { serverId } = parseAgentRequest(input);
    return serverId === "local"
      ? service.listModels()
      : remoteServers.request("/v1/agents/models", {}, serverId, decodeAgentModelOptions);
  });
  handleTrusted(IPC_CHANNELS.agentListBots, (input: unknown) => {
    const { serverId } = parseAgentRequest(input);
    return serverId === "local"
      ? service.listBots()
      : remoteServers.request("/v1/agents", {}, serverId, decodeBotSummaries);
  });
  handleTrusted(IPC_CHANNELS.agentListInstalledSkills, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const botId = requireString(scoped.payload, "botId", INPUT_LIMITS.identifier);
    return scoped.serverId === "local"
      ? skills.listInstalledForChatTags(botId)
      : remoteServers
            .list()
            .find((server) => server.id === scoped.serverId)
            ?.compatibility?.capabilities.includes("installed-skills")
        ? remoteServers.request(
            `/v1/agents/${encodeURIComponent(botId)}/skills`,
            {},
            scoped.serverId,
            decodeInstalledSkills,
          )
        : Promise.resolve([]);
  });
  handleTrusted(IPC_CHANNELS.agentGetSidebarLayout, (input: unknown): Promise<SidebarLayoutSnapshot> => {
    const { serverId } = parseAgentRequest(input);
    return serverId === "local"
      ? Promise.resolve(sidebarLayout.getSnapshot())
      : remoteServers.request("/v1/sidebar-layout", {}, serverId, decodeSidebarLayoutSnapshot);
  });
  handleTrusted(IPC_CHANNELS.agentMutateSidebarLayout, (input: unknown): Promise<SidebarLayoutSnapshot> => {
    const scoped = parseAgentRequest(input);
    const action = parseSidebarLayoutAction(scoped.payload);
    return scoped.serverId === "local"
      ? sidebarLayout.mutate(action, new Set(service.listBots().map((bot) => bot.id)))
      : remoteServers.request(
          "/v1/sidebar-layout/actions",
          { method: "POST", body: action },
          scoped.serverId,
          decodeSidebarLayoutSnapshot,
        );
  });
  handleTrusted(IPC_CHANNELS.agentCreateBot, (input: unknown) => {
    const { serverId, payload } = parseAgentRequest(input);
    const parsed = parseCreateBot(payload);
    return serverId === "local"
      ? service.createBot(parsed)
      : remoteServers.request("/v1/agents", { method: "POST", body: parsed }, serverId, decodeBotSummary);
  });
  handleTrusted(IPC_CHANNELS.agentDuplicateBot, (input: unknown): Promise<DuplicateBotResult> => {
    const scoped = parseAgentRequest(input);
    const botId = requireString(scoped.payload, "botId", INPUT_LIMITS.identifier);
    return routeDuplicateBot(service, sidebarLayout, remoteServers, scoped.serverId, botId);
  });
  handleTrusted(IPC_CHANNELS.agentUpdateBot, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    return routeUpdateBot(service, remoteServers, scoped.serverId, parseUpdateBot(scoped.payload));
  });
  handleTrusted(IPC_CHANNELS.agentSetAvatar, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseSetAgentAvatar(scoped.payload);
    return scoped.serverId === "local"
      ? service.setAvatar(parsed.botId, parsed.image)
      : remoteServers.setAgentAvatar(parsed.botId, parsed.image, scoped.serverId);
  });
  handleTrusted(IPC_CHANNELS.agentDeleteBot, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const botId = requireString(scoped.payload, "botId");
    return routeDeleteBot(service, sidebarLayout, remoteServers, scoped.serverId, botId);
  });
  handleTrusted(IPC_CHANNELS.agentListMemories, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const botId = requireString(scoped.payload, "botId", INPUT_LIMITS.identifier);
    return scoped.serverId === "local"
      ? service.listMemories(botId)
      : remoteServers.request(
          `/v1/agents/${encodeURIComponent(botId)}/memories`,
          {},
          scoped.serverId,
          decodeBotMemories,
        );
  });
  handleTrusted(IPC_CHANNELS.agentCreateMemory, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseCreateBotMemory(scoped.payload);
    return scoped.serverId === "local"
      ? service.createMemory(parsed)
      : remoteServers.request(
          `/v1/agents/${encodeURIComponent(parsed.botId)}/memories`,
          { method: "POST", body: { text: parsed.text } },
          scoped.serverId,
          decodeBotMemory,
        );
  });
  handleTrusted(IPC_CHANNELS.agentUpdateMemory, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseUpdateBotMemory(scoped.payload);
    return scoped.serverId === "local"
      ? service.updateMemory(parsed)
      : remoteServers.request(
          `/v1/agents/${encodeURIComponent(parsed.botId)}/memories/${encodeURIComponent(parsed.memoryId)}`,
          { method: "PATCH", body: { text: parsed.text } },
          scoped.serverId,
          decodeBotMemory,
        );
  });
  handleTrusted(IPC_CHANNELS.agentDeleteMemory, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseDeleteBotMemory(scoped.payload);
    if (scoped.serverId === "local") return service.deleteMemory(parsed);
    return remoteServers.request(
      `/v1/agents/${encodeURIComponent(parsed.botId)}/memories/${encodeURIComponent(parsed.memoryId)}`,
      { method: "DELETE" },
      scoped.serverId,
      decodeVoid,
    );
  });
  handleTrusted(IPC_CHANNELS.agentClearMemories, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const botId = requireString(scoped.payload, "botId", INPUT_LIMITS.identifier);
    if (scoped.serverId === "local") return service.clearMemories(botId);
    return remoteServers.request(
      `/v1/agents/${encodeURIComponent(botId)}/memories`,
      { method: "DELETE" },
      scoped.serverId,
      decodeVoid,
    );
  });
  handleTrusted(IPC_CHANNELS.agentListRoutines, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const botId = requireString(scoped.payload, "botId", INPUT_LIMITS.identifier);
    return scoped.serverId === "local"
      ? service.listRoutines(botId)
      : remoteServers.request(`/v1/agents/${encodeURIComponent(botId)}/routines`, {}, scoped.serverId, decodeRoutines);
  });
  handleTrusted(IPC_CHANNELS.agentCreateRoutine, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseCreateRoutine(scoped.payload);
    return scoped.serverId === "local"
      ? service.createRoutine(parsed)
      : remoteServers.request(
          `/v1/agents/${encodeURIComponent(parsed.botId)}/routines`,
          { method: "POST", body: parsed },
          scoped.serverId,
          decodeRoutine,
        );
  });
  handleTrusted(IPC_CHANNELS.agentUpdateRoutine, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseUpdateRoutine(scoped.payload);
    return scoped.serverId === "local"
      ? service.updateRoutine(parsed)
      : remoteServers.request(
          `/v1/agents/${encodeURIComponent(parsed.botId)}/routines/${encodeURIComponent(parsed.routineId)}`,
          { method: "PATCH", body: parsed },
          scoped.serverId,
          decodeRoutine,
        );
  });
  handleTrusted(IPC_CHANNELS.agentDeleteRoutine, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseDeleteRoutine(scoped.payload);
    if (scoped.serverId === "local") return service.deleteRoutine(parsed);
    return remoteServers.request(
      `/v1/agents/${encodeURIComponent(parsed.botId)}/routines/${encodeURIComponent(parsed.routineId)}`,
      { method: "DELETE" },
      scoped.serverId,
      decodeVoid,
    );
  });
  handleTrusted(IPC_CHANNELS.agentTestRoutine, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseTestRoutine(scoped.payload);
    return scoped.serverId === "local"
      ? service.testRoutine(parsed)
      : remoteServers.request(
          `/v1/agents/${encodeURIComponent(parsed.botId)}/routines/${encodeURIComponent(parsed.routineId)}/test`,
          { method: "POST" },
          scoped.serverId,
          decodeRoutineRun,
        );
  });
  handleTrusted(IPC_CHANNELS.agentListRoutineRuns, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseListRoutineRuns(scoped.payload);
    return scoped.serverId === "local"
      ? service.listRoutineRuns(parsed)
      : remoteServers.request(
          `/v1/agents/${encodeURIComponent(parsed.botId)}/routines/${encodeURIComponent(parsed.routineId)}/runs?limit=${parsed.limit}`,
          {},
          scoped.serverId,
          decodeRoutineRuns,
        );
  });
  handleTrusted(IPC_CHANNELS.agentReadConversation, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    return routeReadConversation(host, remoteServers, scoped.serverId, requireString(scoped.payload, "botId"));
  });
  handleTrusted(IPC_CHANNELS.agentReadConversationPage, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseReadConversationPage(scoped.payload);
    return scoped.serverId === "local"
      ? host.readAgentConversationPage(parsed.botId, parsed.anchor, parsed.limit)
      : remoteServers.readAgentConversationPage(parsed.botId, parsed.anchor, parsed.limit, scoped.serverId);
  });
  handleTrusted(IPC_CHANNELS.agentSearchConversationMessages, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseSearchConversationMessages(scoped.payload);
    return scoped.serverId === "local"
      ? host.searchAgentConversationMessages(parsed.query, parsed.botId, parsed.cursor, parsed.limit)
      : remoteServers.searchAgentConversationMessages(
          parsed.query,
          parsed.botId,
          parsed.cursor,
          parsed.limit,
          scoped.serverId,
        );
  });
  handleTrusted(IPC_CHANNELS.agentListConversationReads, (input: unknown) => {
    const { serverId } = parseAgentRequest(input);
    return serverId === "local"
      ? host.listAgentConversationReads()
      : remoteServers.listAgentConversationReads(serverId);
  });
  handleTrusted(IPC_CHANNELS.agentMarkConversationRead, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseMarkConversationRead(scoped.payload);
    return scoped.serverId === "local"
      ? host.markAgentConversationRead(parsed)
      : remoteServers.markAgentConversationRead(parsed, scoped.serverId);
  });
  handleTrusted(IPC_CHANNELS.agentSendMessage, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    return routeSendMessage(service, remoteServers, scoped.serverId, parseSendMessage(scoped.payload));
  });
  handleTrusted(IPC_CHANNELS.agentSetMessageReaction, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseMessageReaction(scoped.payload);
    return scoped.serverId === "local"
      ? service.setMessageReaction(parsed)
      : remoteServers.request(
          `/v1/agents/${encodeURIComponent(parsed.botId)}/reactions`,
          {
            method: "POST",
            body: parsed,
          },
          scoped.serverId,
          decodeVoid,
        );
  });
  handleTrusted(IPC_CHANNELS.agentChooseAttachments, async (input: unknown) => {
    const { serverId, payload } = parseAgentRequest(input);
    const { filter } = parseChooseAttachments(payload);
    const options: Electron.OpenDialogOptions = {
      properties: ["openFile", "multiSelections"],
      filters:
        filter === "images"
          ? [{ name: "Images", extensions: [...IMAGE_ATTACHMENT_EXTENSIONS] }]
          : [{ name: "Supported files", extensions: [...ATTACHMENT_FILE_EXTENSIONS] }],
    };
    const mainWindow = getMainWindow();
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (result.canceled) return [];
    if (serverId === "local") return service.prepareAttachments(result.filePaths);
    return uploadRemotePaths(remoteServers, serverId, result.filePaths);
  });
  handleTrusted(IPC_CHANNELS.agentImportAttachments, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseImportAttachments(scoped.payload);
    return scoped.serverId === "local"
      ? service.prepareImportedAttachments(parsed.paths, parsed.data)
      : uploadRemoteImports(remoteServers, scoped.serverId, parsed);
  });
  handleTrusted(IPC_CHANNELS.agentDiscardDraftAttachment, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const attachmentId = requireString(scoped.payload, "attachmentId");
    return scoped.serverId === "local"
      ? service.discardDraftAttachment(attachmentId)
      : remoteServers.request(
          `/v1/attachments/${encodeURIComponent(attachmentId)}`,
          { method: "DELETE" },
          scoped.serverId,
          decodeVoid,
        );
  });
  handleTrusted(IPC_CHANNELS.agentOpenAttachment, async (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseOpenAttachment(scoped.payload);
    const mainWindow = getMainWindow();
    if (scoped.serverId !== "local") {
      const downloaded = await remoteServers.downloadAttachment(parsed.attachmentId, scoped.serverId);
      const suggestedName = basename(downloaded.name) || `attachment-${parsed.attachmentId}`;
      if (parsed.action === "download") {
        const extension = extname(suggestedName).slice(1).toLowerCase();
        const saveOptions: Electron.SaveDialogOptions = {
          defaultPath: join(app.getPath("downloads"), suggestedName),
          filters: [{ name: "Attachment", extensions: extension ? [extension] : ["*"] }],
          showsTagField: false,
        };
        const result =
          mainWindow && !mainWindow.isDestroyed()
            ? await dialog.showSaveDialog(mainWindow, saveOptions)
            : await dialog.showSaveDialog(saveOptions);
        if (result.canceled || !result.filePath) return;
        await writeFile(result.filePath, downloaded.bytes, { mode: 0o600 });
        return;
      }
      const cacheRoot = join(app.getPath("userData"), "remote-attachments");
      await mkdir(cacheRoot, { recursive: true });
      const safeName = `${parsed.attachmentId}-${suggestedName}`;
      const target = join(cacheRoot, safeName);
      await writeFile(target, downloaded.bytes, { mode: 0o600 });
      if (parsed.action === "reveal") shell.showItemInFolder(target);
      else {
        const openError = await shell.openPath(target);
        if (openError) throw new Error(openError);
      }
      return;
    }
    const attachment = await mailbox.resolveAttachment(parsed.attachmentId);
    if (!attachment) throw new Error("Attachment was not found.");
    if (parsed.action === "download") {
      const safeId = basename(parsed.attachmentId).replace(/[^a-z0-9_-]/gi, "-") || "attachment";
      const mimeExtension = attachment.mimeType.split("/")[1]?.replace(/[^a-z0-9]/gi, "");
      const suggestedName = `attachment-${safeId}${mimeExtension ? `.${mimeExtension}` : ""}`;
      const extension = extname(suggestedName).slice(1).toLowerCase();
      const saveOptions: Electron.SaveDialogOptions = {
        defaultPath: join(app.getPath("downloads"), suggestedName),
        filters: [{ name: "Attachment", extensions: extension ? [extension] : ["*"] }],
        showsTagField: false,
      };
      const result =
        mainWindow && !mainWindow.isDestroyed()
          ? await dialog.showSaveDialog(mainWindow, saveOptions)
          : await dialog.showSaveDialog(saveOptions);
      if (result.canceled || !result.filePath) return;
      await copyFile(attachment.path, result.filePath);
      return;
    }
    if (parsed.action === "reveal") {
      shell.showItemInFolder(attachment.path);
      return;
    }
    const error = await shell.openPath(attachment.path);
    if (error) throw new Error(error);
  });
  handleTrusted(IPC_CHANNELS.agentOpenSharedFile, async (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseOpenSharedFile(scoped.payload);
    if (scoped.serverId !== "local") {
      const downloaded = await remoteServers.downloadSharedFile(parsed.path, scoped.serverId);
      const cacheRoot = join(app.getPath("userData"), "remote-shared-files");
      await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
      const cacheKey = createHash("sha256").update(`${scoped.serverId}:${parsed.path}`).digest("hex");
      const target = join(cacheRoot, `${cacheKey}-${basename(downloaded.name)}`);
      await writeFile(target, downloaded.bytes, { mode: 0o600 });
      await chmod(target, 0o600);
      const openError = await shell.openPath(target);
      if (openError) throw new Error(openError);
      return;
    }
    const sharedFile = await service.resolveSharedFile(parsed.path);
    const openError = await shell.openPath(sharedFile.path);
    if (openError) throw new Error(openError);
  });
  handleTrusted(IPC_CHANNELS.agentOpenWorkspaceFile, async (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseOpenWorkspaceFile(scoped.payload);
    if (scoped.serverId !== "local") {
      const downloaded = await remoteServers.downloadWorkspaceFile(parsed.botId, parsed.path, scoped.serverId);
      const cacheRoot = join(app.getPath("userData"), "remote-workspace-files");
      await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
      const cacheKey = createHash("sha256").update(`${scoped.serverId}:${parsed.botId}:${parsed.path}`).digest("hex");
      const target = join(cacheRoot, `${cacheKey}-${basename(downloaded.name)}`);
      await writeFile(target, downloaded.bytes, { mode: 0o600 });
      await chmod(target, 0o600);
      const openError = await shell.openPath(target);
      if (openError) throw new Error(openError);
      return;
    }
    const workspaceFile = await service.resolveWorkspaceFile(parsed.botId, parsed.path);
    const openError = await shell.openPath(workspaceFile.path);
    if (openError) throw new Error(openError);
  });
  handleTrusted(IPC_CHANNELS.agentPreviewSharedFile, async (input: unknown): Promise<FilePreview> => {
    const scoped = parseAgentRequest(input);
    const parsed = parseOpenSharedFile(scoped.payload);
    if (scoped.serverId !== "local") {
      const downloaded = await remoteServers.downloadSharedFile(parsed.path, scoped.serverId);
      return filePreviewFromBytes(downloaded.name, downloaded.bytes);
    }
    const sharedFile = await service.resolveSharedFile(parsed.path);
    return localFilePreview(sharedFile.path, sharedFile.name, sharedFile.size);
  });
  handleTrusted(IPC_CHANNELS.agentPreviewWorkspaceFile, async (input: unknown): Promise<FilePreview> => {
    const scoped = parseAgentRequest(input);
    const parsed = parseOpenWorkspaceFile(scoped.payload);
    if (scoped.serverId !== "local") {
      const downloaded = await remoteServers.downloadWorkspaceFile(parsed.botId, parsed.path, scoped.serverId);
      return filePreviewFromBytes(downloaded.name, downloaded.bytes);
    }
    const workspaceFile = await service.resolveWorkspaceFile(parsed.botId, parsed.path);
    return localFilePreview(workspaceFile.path, workspaceFile.name, workspaceFile.size);
  });
  handleTrusted(IPC_CHANNELS.agentListQueue, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    return routeListQueue(service, remoteServers, scoped.serverId, requireString(scoped.payload, "botId"));
  });
  handleTrusted(IPC_CHANNELS.agentAcknowledgeFailedTurn, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseAcknowledgeFailedTurn(scoped.payload);
    return scoped.serverId === "local"
      ? service.acknowledgeFailedTurn(parsed.botId, parsed.turnId)
      : remoteServers.request(
          `/v1/agents/${encodeURIComponent(parsed.botId)}/failures/acknowledge`,
          { method: "POST", body: { turnId: parsed.turnId } },
          scoped.serverId,
          decodeVoid,
        );
  });
  handleTrusted(IPC_CHANNELS.agentCancelQueuedMessage, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseCancelQueuedMessage(scoped.payload);
    return scoped.serverId === "local"
      ? service.cancelQueuedMessage(parsed.botId, parsed.deliveryId)
      : remoteServers.request(
          `/v1/agents/${encodeURIComponent(parsed.botId)}/queue/cancel`,
          {
            method: "POST",
            body: { deliveryId: parsed.deliveryId },
          },
          scoped.serverId,
          decodeVoid,
        );
  });
  handleTrusted(IPC_CHANNELS.agentSteerQueuedMessage, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseSteerQueuedMessage(scoped.payload);
    return scoped.serverId === "local"
      ? service.steerQueuedMessage(parsed)
      : remoteServers.request(
          `/v1/agents/${encodeURIComponent(parsed.botId)}/queue/steer`,
          {
            method: "POST",
            body: { deliveryId: parsed.deliveryId, expectedTurnId: parsed.expectedTurnId },
          },
          scoped.serverId,
          decodeVoid,
        );
  });
  handleTrusted(IPC_CHANNELS.agentUpdateQueuedMessage, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseUpdateQueuedMessage(scoped.payload);
    return scoped.serverId === "local"
      ? service.updateQueuedMessage(parsed)
      : remoteServers.request(
          `/v1/agents/${encodeURIComponent(parsed.botId)}/queue/update`,
          {
            method: "POST",
            body: {
              deliveryId: parsed.deliveryId,
              text: parsed.text,
              keepAttachmentIds: parsed.keepAttachmentIds,
              attachmentDraftIds: parsed.attachmentDraftIds,
            },
          },
          scoped.serverId,
          decodeVoid,
        );
  });
  handleTrusted(IPC_CHANNELS.agentReorderQueue, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseReorderQueue(scoped.payload);
    return scoped.serverId === "local"
      ? service.reorderQueue(parsed)
      : remoteServers.request(
          `/v1/agents/${encodeURIComponent(parsed.botId)}/queue/reorder`,
          { method: "POST", body: { deliveryIds: parsed.deliveryIds } },
          scoped.serverId,
          decodeVoid,
        );
  });
  handleTrusted(IPC_CHANNELS.agentInterrupt, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseInterrupt(scoped.payload);
    return scoped.serverId === "local"
      ? service.interrupt(parsed.botId, parsed.turnId)
      : remoteServers.request(
          `/v1/agents/${encodeURIComponent(parsed.botId)}/interrupt`,
          {
            method: "POST",
            body: { turnId: parsed.turnId },
          },
          scoped.serverId,
          decodeVoid,
        );
  });
  handleTrusted(IPC_CHANNELS.agentRespondToPrompt, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parsePromptResponse(scoped.payload);
    return scoped.serverId === "local"
      ? service.respondToPrompt(parsed)
      : remoteServers.request("/v1/prompts/respond", { method: "POST", body: parsed }, scoped.serverId, decodeVoid);
  });
  handleTrusted(IPC_CHANNELS.agentRespondToApproval, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseApprovalResponse(scoped.payload);
    return scoped.serverId === "local"
      ? service.respondToApproval(parsed)
      : remoteServers.request("/v1/approvals/respond", { method: "POST", body: parsed }, scoped.serverId, decodeVoid);
  });
  handleTrusted(IPC_CHANNELS.agentRespondToBrowserTakeover, (input: unknown) => {
    const scoped = parseAgentRequest(input);
    const parsed = parseBrowserTakeoverResponse(scoped.payload);
    return scoped.serverId === "local"
      ? service.respondToBrowserTakeover(parsed)
      : remoteServers.request(
          "/v1/browser-takeovers/respond",
          { method: "POST", body: parsed },
          scoped.serverId,
          decodeVoid,
        );
  });
}

function routeUpdateBot(
  service: AgentService,
  remoteServers: RemoteServerManager,
  serverId: string,
  input: UpdateBotInput,
) {
  return serverId === "local"
    ? service.updateBot(input)
    : remoteServers.request(
        `/v1/agents/${encodeURIComponent(input.botId)}`,
        {
          method: "PATCH",
          body: input,
        },
        serverId,
        decodeBotSummary,
      );
}

async function routeDeleteBot(
  service: AgentService,
  sidebarLayout: SidebarLayoutStore,
  remoteServers: RemoteServerManager,
  serverId: string,
  botId: string,
): Promise<void> {
  if (serverId === "local") {
    await service.deleteBot(botId);
    await sidebarLayout.removeAgent(botId);
    return;
  }
  await remoteServers.request(`/v1/agents/${encodeURIComponent(botId)}`, { method: "DELETE" }, serverId, decodeVoid);
}

async function routeDuplicateBot(
  service: AgentService,
  sidebarLayout: SidebarLayoutStore,
  remoteServers: RemoteServerManager,
  serverId: string,
  botId: string,
): Promise<DuplicateBotResult> {
  if (serverId !== "local") {
    return remoteServers.duplicateBot(botId, serverId);
  }
  const bot = await service.duplicateBot(botId);
  try {
    const layout = await sidebarLayout.placeDuplicateAfter(botId, bot.id, [
      ...service.listBots().map((candidate) => candidate.id),
      bot.id,
    ]);
    return service.commitBotDuplication(bot.id, layout);
  } catch (error) {
    const rollbackResults = await Promise.allSettled([service.deleteBot(bot.id), sidebarLayout.removeAgent(bot.id)]);
    const rollbackErrors = rollbackResults.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "Agent duplication failed and the incomplete copy could not be removed.",
      );
    }
    throw error;
  }
}

function routeReadConversation(host: HostService, remoteServers: RemoteServerManager, serverId: string, botId: string) {
  return serverId === "local"
    ? host.readAgentConversation(botId)
    : remoteServers.readAgentConversation(botId, serverId);
}

function routeSendMessage(
  service: AgentService,
  remoteServers: RemoteServerManager,
  serverId: string,
  input: SendMessageInput,
) {
  return serverId === "local"
    ? service.sendMessage(input)
    : remoteServers.request(
        `/v1/agents/${encodeURIComponent(input.botId)}/messages`,
        {
          method: "POST",
          body: input,
        },
        serverId,
        decodeQueuedMessageReceipt,
      );
}

function routeListQueue(service: AgentService, remoteServers: RemoteServerManager, serverId: string, botId: string) {
  return serverId === "local"
    ? service.listQueue(botId)
    : remoteServers.request(`/v1/agents/${encodeURIComponent(botId)}/queue`, {}, serverId, decodeQueueSnapshot);
}

async function uploadRemotePaths(remoteServers: RemoteServerManager, serverId: string, paths: string[]) {
  if (paths.length > INPUT_LIMITS.attachments) {
    throw new Error(`Choose at most ${INPUT_LIMITS.attachments} files.`);
  }
  for (const path of paths) assertSupportedAttachmentName(basename(path));
  const files = await Promise.all(
    paths.map(async (path) => ({
      name: basename(path),
      bytes: new Uint8Array(await readFile(path)),
    })),
  );
  const total = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  if (files.some((file) => file.bytes.byteLength > ATTACHMENT_LIMITS.fileBytes)) {
    throw new Error("A file exceeds the 100 MB limit.");
  }
  if (total > ATTACHMENT_LIMITS.totalBytes) {
    throw new Error("Attachments exceed the 250 MB total limit.");
  }
  return Promise.all(
    files.map((file) => remoteServers.uploadAttachment(file.name, mimeTypeForName(file.name), file.bytes, serverId)),
  );
}

async function uploadRemoteImports(
  remoteServers: RemoteServerManager,
  serverId: string,
  input: ImportAttachmentsInput,
) {
  if (input.paths.length + input.data.length > INPUT_LIMITS.attachments) {
    throw new Error(`Choose at most ${INPUT_LIMITS.attachments} files.`);
  }
  const pathFiles = await Promise.all(
    input.paths.map(async (path) => ({
      name: basename(path),
      mimeType: mimeTypeForName(path),
      bytes: new Uint8Array(await readFile(path)),
    })),
  );
  const files = [
    ...pathFiles,
    ...input.data.map((item) => ({
      name: basename(item.name),
      mimeType: item.mimeType,
      bytes: item.bytes,
    })),
  ];
  for (const file of files) assertSupportedAttachmentName(file.name);
  if (files.some((file) => file.bytes.byteLength > ATTACHMENT_LIMITS.fileBytes)) {
    throw new Error("A file exceeds the 100 MB limit.");
  }
  if (files.reduce((sum, file) => sum + file.bytes.byteLength, 0) > ATTACHMENT_LIMITS.totalBytes) {
    throw new Error("Attachments exceed the 250 MB total limit.");
  }
  return Promise.all(
    files.map((file) => remoteServers.uploadAttachment(file.name, file.mimeType, file.bytes, serverId)),
  );
}

function assertSupportedAttachmentName(name: string): void {
  if (isSupportedAttachmentName(name)) return;
  throw new Error(`${name} is not supported. Attach ${SUPPORTED_ATTACHMENT_DESCRIPTION}.`);
}
