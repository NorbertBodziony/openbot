import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isString } from "@openbot/contracts/runtime-values";
import type { AgentClient, AgentProvider } from "../src/backend/agent-client";
import { CodexAppServerClient } from "../src/backend/app-server-client";
import { ClaudeAgentClient } from "../src/backend/claude-client";
import { resolveClaudeCli, resolveCodexCli } from "../src/backend/cli";
import {
  decodeRecordResponse,
  decodeThreadResponse,
  decodeTurnResponse,
  isRecord,
  type RequestId,
} from "../src/backend/protocol";

const temporaryRoot = await mkdtemp(join(tmpdir(), "openbot-filesystem-smoke-"));
const sharedRoot = join(temporaryRoot, "shared");
const useImagegen = process.argv.includes("--imagegen");
const providers = requestedProviders();

try {
  await mkdir(sharedRoot, { recursive: true });
  if (useImagegen) {
    if (providers.length !== 1 || providers[0] !== "codex") {
      throw new Error("Image generation smoke only supports --provider codex.");
    }
    await runImagegenSmoke();
  } else {
    await writeFile(join(sharedRoot, "shared-seed.txt"), "OPENBOT_SHARED_SEED\n");
    const completedProviders: AgentProvider[] = [];
    for (const provider of providers) {
      await runFilesystemSmoke(provider, completedProviders);
      completedProviders.push(provider);
    }
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function runFilesystemSmoke(provider: AgentProvider, completedProviders: AgentProvider[]): Promise<void> {
  const workspaceRoot = join(temporaryRoot, `workspace-${provider}`);
  const workspaceSeedPath = join(workspaceRoot, "workspace-seed.txt");
  const deletePath = join(workspaceRoot, "delete-me.txt");
  const temporaryPath = join(workspaceRoot, "rename-me.txt");
  const workspaceResultPath = join(workspaceRoot, "workspace-result.txt");
  const persistenceResultPath = join(workspaceRoot, "persistence-result.txt");
  const sharedResultPath = join(sharedRoot, `${provider}-shared-result.txt`);
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(workspaceSeedPath, `OPENBOT_${provider.toUpperCase()}_WORKSPACE_SEED\n`);
  await writeFile(deletePath, "DELETE_ME\n");
  await writeFile(temporaryPath, "RENAME_ME\n");

  const { client, model, version } = await createClient(provider);
  let approvals = 0;
  client.on("request", (request) => {
    if (isApprovalRequest(request.method)) approvals += 1;
    respondToServerRequest(client, request);
  });
  client.start();
  try {
    await initialize(client);
    const started = await client.request(
      "thread/start",
      {
        model,
        effort: "medium",
        cwd: workspaceRoot,
        runtimeWorkspaceRoots: [workspaceRoot, sharedRoot],
        approvalPolicy: "on-request",
        sandbox: "danger-full-access",
        ephemeral: provider === "codex",
        persistSession: false,
        serviceName: "openbot_filesystem_smoke",
        developerInstructions: [
          "This is an isolated local filesystem smoke test.",
          `Your persistent workspace is ${workspaceRoot}.`,
          `The persistent shared directory is ${sharedRoot}.`,
          "You have full filesystem and command access. Do not use the network or modify files outside those directories.",
        ].join("\n"),
      },
      decodeThreadResponse,
    );

    const completion = waitForTurn(client, 180_000);
    await client.request(
      "turn/start",
      {
        threadId: started.thread.id,
        model,
        effort: "medium",
        cwd: workspaceRoot,
        runtimeWorkspaceRoots: [workspaceRoot, sharedRoot],
        approvalPolicy: "on-request",
        sandboxPolicy: { type: "dangerFullAccess" },
        input: [
          {
            type: "text",
            text: [
              "Use local system commands for every step.",
              `Run pwd and verify it prints ${workspaceRoot}.`,
              `Run ls and grep to verify ${workspaceSeedPath} contains OPENBOT_${provider.toUpperCase()}_WORKSPACE_SEED.`,
              `Run grep to verify ${join(sharedRoot, "shared-seed.txt")} contains OPENBOT_SHARED_SEED.`,
              ...completedProviders.map(
                (completedProvider) =>
                  `Run grep to verify ${join(sharedRoot, `${completedProvider}-shared-result.txt`)} contains OPENBOT_${completedProvider.toUpperCase()}_SHARED_OK.`,
              ),
              `Replace ${temporaryPath} with ${workspaceResultPath} using mv, then write exactly OPENBOT_${provider.toUpperCase()}_WORKSPACE_OK followed by one newline to it.`,
              `Delete ${deletePath} using rm.`,
              `Write exactly OPENBOT_${provider.toUpperCase()}_SHARED_OK followed by one newline to ${sharedResultPath}.`,
              "Verify the results with local commands, then finish with a short confirmation.",
            ].join("\n"),
          },
        ],
      },
      decodeTurnResponse,
    );
    await completion;

    const persistenceCompletion = waitForTurn(client, 180_000);
    await client.request(
      "turn/start",
      {
        threadId: started.thread.id,
        model,
        effort: "medium",
        cwd: workspaceRoot,
        runtimeWorkspaceRoots: [workspaceRoot, sharedRoot],
        approvalPolicy: "on-request",
        sandboxPolicy: { type: "dangerFullAccess" },
        input: [
          {
            type: "text",
            text: [
              `In this new turn, run grep to confirm ${workspaceResultPath} still contains OPENBOT_${provider.toUpperCase()}_WORKSPACE_OK.`,
              `Run grep to confirm ${sharedResultPath} still contains OPENBOT_${provider.toUpperCase()}_SHARED_OK.`,
              `Write exactly OPENBOT_${provider.toUpperCase()}_PERSISTENCE_OK followed by one newline to ${persistenceResultPath}.`,
              "Finish with a short confirmation.",
            ].join("\n"),
          },
        ],
      },
      decodeTurnResponse,
    );
    await persistenceCompletion;

    const workspaceResult = await readFile(workspaceResultPath, "utf8");
    if (workspaceResult !== `OPENBOT_${provider.toUpperCase()}_WORKSPACE_OK\n`) {
      throw new Error(`${provider} wrote unexpected workspace contents.`);
    }
    const sharedResult = await readFile(sharedResultPath, "utf8");
    if (sharedResult !== `OPENBOT_${provider.toUpperCase()}_SHARED_OK\n`) {
      throw new Error(`${provider} wrote unexpected shared contents.`);
    }
    const persistenceResult = await readFile(persistenceResultPath, "utf8");
    if (persistenceResult !== `OPENBOT_${provider.toUpperCase()}_PERSISTENCE_OK\n`) {
      throw new Error(`${provider} did not retain its workspace across turns.`);
    }
    await expectMissing(deletePath, `${provider} did not delete the requested workspace file.`);
    await expectMissing(temporaryPath, `${provider} did not move the requested workspace file.`);
    if (approvals !== 0) throw new Error(`${provider} requested ${approvals} approval(s) for routine filesystem work.`);

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          mode: "filesystem",
          provider,
          cliVersion: version,
          workspace: workspaceResultPath,
          shared: sharedResultPath,
          approvals,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await client.stop();
  }
}

async function runImagegenSmoke(): Promise<void> {
  const workspaceRoot = join(temporaryRoot, "workspace-codex");
  const imagePath = join(workspaceRoot, "smoke-image.png");
  await mkdir(workspaceRoot, { recursive: true });
  const { client, model, version } = await createClient("codex");
  client.on("request", (request) => respondToServerRequest(client, request));
  client.start();
  try {
    await initialize(client);
    const started = await client.request(
      "thread/start",
      {
        model,
        effort: "medium",
        cwd: workspaceRoot,
        runtimeWorkspaceRoots: [workspaceRoot, sharedRoot],
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        ephemeral: true,
        serviceName: "openbot_filesystem_smoke",
        developerInstructions: [
          "This is an isolated local image-generation smoke test.",
          `Only create files inside ${workspaceRoot}.`,
          "Use the installed imagegen skill and its image generation tool. Do not modify any other files.",
        ].join("\n"),
      },
      decodeThreadResponse,
    );

    const completion = waitForTurn(client, 300_000);
    await client.request(
      "turn/start",
      {
        threadId: started.thread.id,
        model,
        effort: "medium",
        cwd: workspaceRoot,
        runtimeWorkspaceRoots: [workspaceRoot, sharedRoot],
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
        input: [
          {
            type: "text",
            text: [
              "Use $imagegen and the real image generation tool, not drawing code, SVG, Canvas, or a hand-written PNG.",
              "Generate a polished square illustration of a small red robot passing a file to a yellow robot on a dark background.",
              `Save or copy the final generated PNG to ${imagePath}.`,
              "Verify the PNG exists, then finish with a short confirmation.",
            ].join("\n"),
          },
        ],
      },
      decodeTurnResponse,
    );
    await completion;

    const image = await readFile(imagePath);
    const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    if (!image.subarray(0, 8).equals(pngSignature)) throw new Error("The generated image is not PNG.");
    const info = await stat(imagePath);
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          mode: "imagegen",
          provider: "codex",
          cliVersion: version,
          image: {
            path: imagePath,
            bytes: info.size,
            width: image.readUInt32BE(16),
            height: image.readUInt32BE(20),
          },
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await client.stop();
  }
}

async function createClient(provider: AgentProvider): Promise<{
  client: AgentClient;
  model: string;
  version: string;
}> {
  if (provider === "claude") {
    const cli = await resolveClaudeCli();
    return { client: new ClaudeAgentClient(cli), model: "claude-sonnet-5", version: cli.version };
  }
  const cli = await resolveCodexCli();
  return { client: new CodexAppServerClient(cli.executable, 60_000), model: "gpt-5.6-luna", version: cli.version };
}

async function initialize(client: AgentClient): Promise<void> {
  await client.request(
    "initialize",
    {
      clientInfo: {
        name: "openbot_filesystem_smoke",
        title: "OpenBot Filesystem Smoke",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    },
    decodeRecordResponse,
  );
  client.notify("initialized");
}

function requestedProviders(): AgentProvider[] {
  const index = process.argv.indexOf("--provider");
  const requested = index >= 0 ? process.argv[index + 1] : "all";
  if (requested === "all") return ["codex", "claude"];
  if (requested === "codex" || requested === "claude") return [requested];
  throw new Error("--provider must be codex, claude, or all.");
}

function isApprovalRequest(method: string): boolean {
  return [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "applyPatchApproval",
    "execCommandApproval",
  ].includes(method);
}

function respondToServerRequest(
  activeClient: AgentClient,
  request: { id: RequestId; method: string; params: unknown },
): void {
  switch (request.method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      activeClient.respond(request.id, { decision: "acceptForSession" });
      return;
    case "applyPatchApproval":
    case "execCommandApproval":
      activeClient.respond(request.id, { decision: "approved_for_session" });
      return;
    case "item/permissions/requestApproval": {
      const params = isRecord(request.params) ? request.params : {};
      const permissions = isRecord(params.permissions) ? params.permissions : {};
      activeClient.respond(request.id, { permissions, scope: "session" });
      return;
    }
    case "currentTime/read":
      activeClient.respond(request.id, { currentTimeAt: Math.floor(Date.now() / 1_000) });
      return;
    default:
      activeClient.respondError(request.id, {
        code: -32601,
        message: `Filesystem smoke does not implement ${request.method}.`,
      });
  }
}

function waitForTurn(activeClient: AgentClient, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Filesystem smoke turn timed out.")), timeoutMs);
    activeClient.on("notification", (notification) => {
      if (notification.method !== "turn/completed" || !isRecord(notification.params)) return;
      const turn = isRecord(notification.params.turn) ? notification.params.turn : null;
      const status = turn && isString(turn.status) ? turn.status : "completed";
      clearTimeout(timeout);
      if (status === "completed") resolve();
      else reject(new Error(`Filesystem smoke turn finished with status ${status}.`));
    });
  });
}

async function expectMissing(path: string, message: string): Promise<void> {
  try {
    await access(path);
  } catch {
    return;
  }
  throw new Error(message);
}
