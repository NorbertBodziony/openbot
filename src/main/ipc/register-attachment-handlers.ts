// Attachments, and the shared and workspace files an agent can open or preview.
// Every path here crosses to the local filesystem, so the parsers are the boundary.

import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { ATTACHMENT_FILE_EXTENSIONS, IMAGE_ATTACHMENT_EXTENSIONS } from "@openbot/contracts/attachment-files";
import { ATTACHMENT_LIMITS, INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { type FilePreview, type ImportAttachmentsInput, IPC_CHANNELS } from "@openbot/contracts/ipc";
import { app, type BrowserWindow, dialog, type OpenDialogOptions, shell } from "electron";
import type { AgentService } from "../../backend/agent-service";
import type { MailboxStore } from "../../backend/mailbox-store";
import { normalizeAttachmentImports } from "../attachment-import";
import { filePreviewFromBytes, localFilePreview, mimeTypeForName } from "../file-preview";
import type { RemoteServerManager } from "../remote-server-manager";
import { handleTrusted } from "../trusted-ipc";
import {
  parseAgentRequest,
  parseChooseAttachments,
  parseImportAttachments,
  parseOpenAttachment,
  parseOpenSharedFile,
  parseOpenWorkspaceFile,
} from "./agent-inputs";
import { requireString } from "./validation";

interface AttachmentIpcDependencies {
  service: AgentService;
  mailbox: MailboxStore;
  remoteServers: RemoteServerManager;
  getMainWindow: () => BrowserWindow | null;
}

export function registerAttachmentIpcHandlers({
  service,
  mailbox,
  remoteServers,
  getMainWindow,
}: AttachmentIpcDependencies): void {
  handleTrusted(IPC_CHANNELS.agentChooseAttachments, parseAgentRequest, async (parsed) => {
    const mainWindow = getMainWindow();
    const { serverId, payload } = parsed;
    const { filter } = parseChooseAttachments(payload);
    const options: OpenDialogOptions = {
      properties: ["openFile", "multiSelections"],
      filters:
        filter === "images"
          ? [{ name: "Images", extensions: [...IMAGE_ATTACHMENT_EXTENSIONS] }]
          : [{ name: "Supported files", extensions: [...ATTACHMENT_FILE_EXTENSIONS] }],
    };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (result.canceled) return [];
    return routeImportAttachments(service, remoteServers, serverId, { paths: result.filePaths, data: [] });
  });
  handleTrusted(IPC_CHANNELS.agentImportAttachments, parseAgentRequest, async (scoped) => {
    const parsed = parseImportAttachments(scoped.payload);
    return routeImportAttachments(service, remoteServers, scoped.serverId, parsed);
  });
  handleTrusted(IPC_CHANNELS.agentDiscardDraftAttachment, parseAgentRequest, (scoped) => {
    const attachmentId = requireString(scoped.payload, "attachmentId");
    return scoped.serverId === "local"
      ? service.discardDraftAttachment(attachmentId)
      : remoteServers.discardDraftAttachment(attachmentId, scoped.serverId);
  });
  handleTrusted(IPC_CHANNELS.agentOpenAttachment, parseAgentRequest, async (scoped) => {
    const mainWindow = getMainWindow();
    const parsed = parseOpenAttachment(scoped.payload);
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
  handleTrusted(IPC_CHANNELS.agentOpenSharedFile, parseAgentRequest, async (scoped) => {
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
  handleTrusted(IPC_CHANNELS.agentOpenWorkspaceFile, parseAgentRequest, async (scoped) => {
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
  handleTrusted(IPC_CHANNELS.agentPreviewSharedFile, parseAgentRequest, async (scoped): Promise<FilePreview> => {
    const parsed = parseOpenSharedFile(scoped.payload);
    if (scoped.serverId !== "local") {
      const downloaded = await remoteServers.downloadSharedFile(parsed.path, scoped.serverId);
      return filePreviewFromBytes(downloaded.name, downloaded.bytes);
    }
    const sharedFile = await service.resolveSharedFile(parsed.path);
    return localFilePreview(sharedFile.path, sharedFile.name, sharedFile.size);
  });
  handleTrusted(IPC_CHANNELS.agentPreviewWorkspaceFile, parseAgentRequest, async (scoped): Promise<FilePreview> => {
    const parsed = parseOpenWorkspaceFile(scoped.payload);
    if (scoped.serverId !== "local") {
      const downloaded = await remoteServers.downloadWorkspaceFile(parsed.botId, parsed.path, scoped.serverId);
      return filePreviewFromBytes(downloaded.name, downloaded.bytes);
    }
    const workspaceFile = await service.resolveWorkspaceFile(parsed.botId, parsed.path);
    return localFilePreview(workspaceFile.path, workspaceFile.name, workspaceFile.size);
  });
}

async function routeImportAttachments(
  service: AgentService,
  remoteServers: RemoteServerManager,
  serverId: string,
  input: ImportAttachmentsInput,
) {
  const normalized = await normalizeAttachmentImports(input);
  return serverId === "local"
    ? service.prepareImportedAttachments(normalized.paths, normalized.data)
    : uploadRemoteImports(remoteServers, serverId, normalized);
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
  if (files.some((file) => file.bytes.byteLength > ATTACHMENT_LIMITS.fileBytes)) {
    throw new Error("A file exceeds the 100 MB limit.");
  }
  if (files.reduce((sum, file) => sum + file.bytes.byteLength, 0) > ATTACHMENT_LIMITS.totalBytes) {
    throw new Error("Attachments exceed the 250 MB total limit.");
  }
  return remoteServers.uploadAttachments(files, serverId);
}
