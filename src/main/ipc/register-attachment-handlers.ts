// Attachments, and the shared and workspace files an agent can open or preview.
// Every path here crosses to the local filesystem, so the parsers are the boundary.

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
import { routeToServer } from "./route-to-server";
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
    return routeToServer(scoped.serverId, {
      local: () => service.discardDraftAttachment(attachmentId),
      remote: (serverId) => remoteServers.discardDraftAttachment(attachmentId, serverId),
    });
  });
  handleTrusted(IPC_CHANNELS.agentOpenAttachment, parseAgentRequest, (scoped) => {
    const parsed = parseOpenAttachment(scoped.payload);
    return routeToServer<void>(scoped.serverId, {
      local: async () => {
        const attachment = await mailbox.resolveAttachment(parsed.attachmentId);
        if (!attachment) throw new Error("Attachment was not found.");
        if (parsed.action === "download") {
          const safeId = basename(parsed.attachmentId).replace(/[^a-z0-9_-]/gi, "-") || "attachment";
          const mimeExtension = attachment.mimeType.split("/")[1]?.replace(/[^a-z0-9]/gi, "");
          const suggestedName = `attachment-${safeId}${mimeExtension ? `.${mimeExtension}` : ""}`;
          const filePath = await chooseSavePath(getMainWindow(), suggestedName);
          if (!filePath) return;
          await copyFile(attachment.path, filePath);
          return;
        }
        if (parsed.action === "reveal") {
          shell.showItemInFolder(attachment.path);
          return;
        }
        await openPath(attachment.path);
      },
      remote: async (serverId) => {
        const downloaded = await remoteServers.downloadAttachment(parsed.attachmentId, serverId);
        const suggestedName = basename(downloaded.name) || `attachment-${parsed.attachmentId}`;
        if (parsed.action === "download") {
          const filePath = await chooseSavePath(getMainWindow(), suggestedName);
          if (!filePath) return;
          await writeFile(filePath, downloaded.bytes, { mode: 0o600 });
          return;
        }
        const cacheRoot = join(app.getPath("userData"), "remote-attachments");
        await mkdir(cacheRoot, { recursive: true });
        const target = join(cacheRoot, `${parsed.attachmentId}-${suggestedName}`);
        await writeFile(target, downloaded.bytes, { mode: 0o600 });
        if (parsed.action === "reveal") shell.showItemInFolder(target);
        else await openPath(target);
      },
    });
  });
  handleTrusted(IPC_CHANNELS.agentOpenSharedFile, parseAgentRequest, (scoped) => {
    const parsed = parseOpenSharedFile(scoped.payload);
    return routeToServer<void>(scoped.serverId, {
      local: async () => {
        const sharedFile = await service.resolveSharedFile(parsed.path);
        await openPath(sharedFile.path);
      },
      remote: async (serverId) => {
        const downloaded = await remoteServers.downloadSharedFile(parsed.path, serverId);
        const target = await cacheRemoteFile("remote-shared-files", `${serverId}:${parsed.path}`, downloaded);
        await openPath(target);
      },
    });
  });
  handleTrusted(IPC_CHANNELS.agentOpenWorkspaceFile, parseAgentRequest, (scoped) => {
    const parsed = parseOpenWorkspaceFile(scoped.payload);
    return routeToServer<void>(scoped.serverId, {
      local: async () => {
        const workspaceFile = await service.resolveWorkspaceFile(parsed.botId, parsed.path);
        await openPath(workspaceFile.path);
      },
      remote: async (serverId) => {
        const downloaded = await remoteServers.downloadWorkspaceFile(parsed.botId, parsed.path, serverId);
        const key = `${serverId}:${parsed.botId}:${parsed.path}`;
        const target = await cacheRemoteFile("remote-workspace-files", key, downloaded);
        await openPath(target);
      },
    });
  });
  handleTrusted(IPC_CHANNELS.agentPreviewSharedFile, parseAgentRequest, (scoped): Promise<FilePreview> => {
    const parsed = parseOpenSharedFile(scoped.payload);
    return routeToServer(scoped.serverId, {
      local: async () => {
        const sharedFile = await service.resolveSharedFile(parsed.path);
        return localFilePreview(sharedFile.path, sharedFile.name, sharedFile.size);
      },
      remote: async (serverId) => {
        const downloaded = await remoteServers.downloadSharedFile(parsed.path, serverId);
        return filePreviewFromBytes(downloaded.name, downloaded.bytes);
      },
    });
  });
  handleTrusted(IPC_CHANNELS.agentPreviewWorkspaceFile, parseAgentRequest, (scoped): Promise<FilePreview> => {
    const parsed = parseOpenWorkspaceFile(scoped.payload);
    return routeToServer(scoped.serverId, {
      local: async () => {
        const workspaceFile = await service.resolveWorkspaceFile(parsed.botId, parsed.path);
        return localFilePreview(workspaceFile.path, workspaceFile.name, workspaceFile.size);
      },
      remote: async (serverId) => {
        const downloaded = await remoteServers.downloadWorkspaceFile(parsed.botId, parsed.path, serverId);
        return filePreviewFromBytes(downloaded.name, downloaded.bytes);
      },
    });
  });
}

async function routeImportAttachments(
  service: AgentService,
  remoteServers: RemoteServerManager,
  serverId: string,
  input: ImportAttachmentsInput,
) {
  const normalized = await normalizeAttachmentImports(input);
  return routeToServer(serverId, {
    local: () => service.prepareImportedAttachments(normalized.paths, normalized.data),
    remote: (target) => uploadRemoteImports(remoteServers, target, normalized),
  });
}

// A remote file has to land on disk before the OS can open it. Owner-only, under a per-server and
// per-path digest so two servers sharing a file name cannot overwrite each other.
async function cacheRemoteFile(
  directory: string,
  cacheKeyInput: string,
  downloaded: { name: string; bytes: Uint8Array },
): Promise<string> {
  const cacheRoot = join(app.getPath("userData"), directory);
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const cacheKey = createHash("sha256").update(cacheKeyInput).digest("hex");
  const target = join(cacheRoot, `${cacheKey}-${basename(downloaded.name)}`);
  await writeFile(target, downloaded.bytes, { mode: 0o600 });
  await chmod(target, 0o600);
  return target;
}

// `shell.openPath` reports failure by resolving with the message rather than rejecting.
async function openPath(path: string): Promise<void> {
  const error = await shell.openPath(path);
  if (error) throw new Error(error);
}

// Returns the chosen path, or undefined when the user cancelled.
async function chooseSavePath(mainWindow: BrowserWindow | null, suggestedName: string): Promise<string | undefined> {
  const extension = extname(suggestedName).slice(1).toLowerCase();
  const options: Electron.SaveDialogOptions = {
    defaultPath: join(app.getPath("downloads"), suggestedName),
    filters: [{ name: "Attachment", extensions: extension ? [extension] : ["*"] }],
    showsTagField: false,
  };
  const result =
    mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showSaveDialog(mainWindow, options)
      : await dialog.showSaveDialog(options);
  return result.canceled ? undefined : result.filePath || undefined;
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
  return remoteServers.uploadAttachments(files, serverId);
}

function assertSupportedAttachmentName(name: string): void {
  if (isSupportedAttachmentName(name)) return;
  throw new Error(`${name} is not supported. Attach ${SUPPORTED_ATTACHMENT_DESCRIPTION}.`);
}
