import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { arch, release as osRelease, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { AgentSummary, ExportResult } from "@openbot/contracts/ipc";
import { app, type BrowserWindow, dialog } from "electron";
import type { AgentService } from "../backend/agent-service";
import type { BrowserHost } from "../backend/browser-host";
import type { MailboxStore } from "../backend/mailbox-store";
import type { UpdateService } from "./update-service";

const execFileAsync = promisify(execFile);

interface MaintenanceContext {
  service: AgentService;
  browser: BrowserHost;
  mailbox: MailboxStore;
  updater: UpdateService;
  parentWindow: BrowserWindow | null;
}

export async function exportOpenBotData(
  context: Pick<MaintenanceContext, "service" | "mailbox" | "parentWindow">,
): Promise<ExportResult> {
  const destination = await chooseExportDestination(
    context.parentWindow,
    `OpenBot-backup-${new Date().toISOString().slice(0, 10)}.zip`,
    [{ name: "ZIP archive", extensions: ["zip"] }],
  );
  if (!destination) return { saved: false };

  const temporaryRoot = await mkdtemp(join(tmpdir(), "openbot-export-"));
  const exportRoot = join(temporaryRoot, "OpenBot Backup");
  const archiveCandidate = `${destination}.${randomUUID()}.tmp.zip`;
  try {
    await mkdir(exportRoot, { recursive: true, mode: 0o700 });
    const agents = context.service.listAgents();
    const [conversations, queues, attachments] = await Promise.all([
      Promise.all(agents.map((agent) => context.service.readConversation(agent.id))),
      Promise.resolve(agents.map((agent) => context.service.listQueue(agent.id))),
      context.mailbox.listExportAttachments(),
    ]);
    const manifest = {
      schemaVersion: 3,
      exportedAt: new Date().toISOString(),
      application: { name: "OpenBot", version: app.getVersion() },
      scope: {
        includes: ["agent profiles", "agent memories", "conversation snapshots", "queues", "attachments"],
        excludes: ["Codex credentials", "browser cookies", "agent workspace files"],
      },
      agents: agents.map(toBackupAgent),
      memories: agents.flatMap((agent) => context.service.listMemories(agent.id)),
      conversations,
      queues,
    };
    await writeFile(join(exportRoot, "openbot-data.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    for (const attachment of attachments) {
      const target = join(exportRoot, attachment.relativePath);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(attachment.sourcePath, target);
    }
    if (process.platform === "win32") {
      await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Compress-Archive -LiteralPath '${powerShellLiteral(exportRoot)}' -DestinationPath '${powerShellLiteral(archiveCandidate)}' -Force`,
      ]);
    } else {
      await execFileAsync("/usr/bin/ditto", ["-c", "-k", "--keepParent", exportRoot, archiveCandidate]);
    }
    await rename(archiveCandidate, destination);
    return { saved: true };
  } finally {
    await Promise.all([rm(temporaryRoot, { recursive: true, force: true }), rm(archiveCandidate, { force: true })]);
  }
}

function powerShellLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

export async function exportDiagnostics(
  context: Pick<MaintenanceContext, "service" | "browser" | "updater" | "parentWindow">,
): Promise<ExportResult> {
  const destination = await chooseExportDestination(
    context.parentWindow,
    `OpenBot-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
    [{ name: "JSON document", extensions: ["json"] }],
  );
  if (!destination) return { saved: false };

  const status = context.service.getStatus();
  const agents = context.service.listAgents();
  const queueCounts = agents.map((agent) => {
    const queue = context.service.listQueue(agent.id);
    return {
      agentId: agent.id,
      deliveries: Object.fromEntries(
        ["queued", "starting", "running", "completed", "failed", "interrupted", "cancelled"].map((deliveryStatus) => [
          deliveryStatus,
          queue.deliveries.filter((delivery) => delivery.status === deliveryStatus).length,
        ]),
      ),
    };
  });
  const update = context.updater.getStatus();
  const diagnostics = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    application: {
      version: app.getVersion(),
      packaged: app.isPackaged,
      platform: process.platform,
      architecture: arch(),
      osRelease: osRelease(),
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      node: process.versions.node,
    },
    agent: {
      phase: status.phase,
      cliVersion: status.cliVersion,
      authentication: status.auth.kind,
      capabilities: status.capabilities,
      fullAccess: status.fullAccess,
      agentCount: agents.length,
      queues: queueCounts,
    },
    browser: {
      tabCount: context.browser.listTabs().length,
      activeControlCount: context.browser.getControlState().sessions.length,
    },
    update: {
      phase: update.phase,
      currentVersion: update.currentVersion,
      availableVersion: update.availableVersion,
      progress: update.progress,
      checkedAt: update.checkedAt,
      errorCode: update.errorCode,
      history: context.updater.getDiagnostics(),
    },
    privacy:
      "Contains no conversations, URLs, email addresses, tokens, file contents, file paths, or raw error messages.",
  };
  await writeFile(destination, `${JSON.stringify(diagnostics, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return { saved: true };
}

async function chooseExportDestination(
  parentWindow: BrowserWindow | null,
  defaultName: string,
  filters: Electron.FileFilter[],
): Promise<string | null> {
  const options: Electron.SaveDialogOptions = {
    defaultPath: join(app.getPath("documents"), defaultName),
    filters,
    showsTagField: false,
  };
  const result = parentWindow
    ? await dialog.showSaveDialog(parentWindow, options)
    : await dialog.showSaveDialog(options);
  return result.canceled || !result.filePath ? null : result.filePath;
}

function toBackupAgent(agent: AgentSummary): Omit<AgentSummary, "workspacePath"> {
  return {
    id: agent.id,
    provider: agent.provider,
    name: agent.name,
    title: agent.title,
    description: agent.description,
    notifications: agent.notifications,
    model: agent.model,
    reasoningEffort: agent.reasoningEffort,
    threadId: agent.threadId,
    preview: agent.preview,
    updatedAt: agent.updatedAt,
    avatarSeed: agent.avatarSeed,
    avatarHue: agent.avatarHue,
    avatarUrl: agent.avatarUrl,
  };
}
