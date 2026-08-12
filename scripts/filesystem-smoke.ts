import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServerClient } from "../src/backend/app-server-client";
import { resolveCodexCli } from "../src/backend/cli";
import { isRecord, type RequestId } from "../src/backend/protocol";

const temporaryRoot = await mkdtemp(join(tmpdir(), "openbot-filesystem-smoke-"));
const textPath = join(temporaryRoot, "smoke-note.txt");
const imagePath = join(temporaryRoot, "smoke-image.png");
const useImagegen = process.argv.includes("--imagegen");
let client: CodexAppServerClient | null = null;

try {
  const cli = await resolveCodexCli();
  client = new CodexAppServerClient(cli.executable, 60_000);
  client.on("request", (request) => respondToServerRequest(client, request));
  client.start();
  await client.request("initialize", {
    clientInfo: {
      name: "openbot_filesystem_smoke",
      title: "OpenBot Filesystem Smoke",
      version: "0.1.0",
    },
    capabilities: { experimentalApi: true },
  });
  client.notify("initialized");

  const started = await client.request<{ thread: { id: string } }>("thread/start", {
    cwd: temporaryRoot,
    runtimeWorkspaceRoots: [temporaryRoot],
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    ephemeral: true,
    serviceName: "openbot_filesystem_smoke",
    developerInstructions: [
      "This is an isolated local filesystem smoke test.",
      `Only create files inside ${temporaryRoot}.`,
      useImagegen
        ? "Use the installed imagegen skill and its image generation tool. Do not modify any other files."
        : "Do not use the network and do not modify any other files.",
    ].join("\n"),
  });

  const completion = waitForTurn(client, useImagegen ? 300_000 : 120_000);
  await client.request("turn/start", {
    threadId: started.thread.id,
    model: "gpt-5.6-luna",
    effort: "medium",
    cwd: temporaryRoot,
    runtimeWorkspaceRoots: [temporaryRoot],
    approvalPolicy: "never",
    sandboxPolicy: { type: "dangerFullAccess" },
    input: [
      {
        type: "text",
        text: useImagegen
          ? [
              "Use $imagegen and the real image generation tool, not drawing code, SVG, Canvas, or a hand-written PNG.",
              "Generate a polished square illustration of a small red robot passing a file to a yellow robot on a dark background.",
              `Save or copy the final generated PNG to ${imagePath}.`,
              "Verify the PNG exists, then finish with a short confirmation.",
            ].join("\n")
          : [
              `Create ${textPath} containing exactly OPENBOT_FILE_OK followed by one newline.`,
              `Create a valid 256 by 256 PNG at ${imagePath}.`,
              "The PNG must have a transparent background and a solid red circle in the center.",
              "Use only local command-line tools or code already available on this Mac.",
              "Verify both files yourself, then finish with a short confirmation.",
            ].join("\n"),
      },
    ],
  });
  await completion;

  if (!useImagegen) {
    const text = await readFile(textPath, "utf8");
    if (text !== "OPENBOT_FILE_OK\n")
      throw new Error("The generated text file has invalid contents.");
  }

  const image = await readFile(imagePath);
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!image.subarray(0, 8).equals(pngSignature))
    throw new Error("The generated image is not PNG.");
  const width = image.readUInt32BE(16);
  const height = image.readUInt32BE(20);
  if (!useImagegen && (width !== 256 || height !== 256)) {
    throw new Error("The generated PNG does not have the requested dimensions.");
  }

  const [textInfo, imageInfo] = await Promise.all([
    useImagegen ? Promise.resolve(null) : stat(textPath),
    stat(imagePath),
  ]);
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        mode: useImagegen ? "imagegen" : "filesystem",
        cliVersion: cli.version,
        text: textInfo ? { path: textPath, bytes: textInfo.size } : null,
        image: { path: imagePath, bytes: imageInfo.size, width, height },
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (client) await client.stop();
  await rm(temporaryRoot, { recursive: true, force: true });
}

function respondToServerRequest(
  activeClient: CodexAppServerClient | null,
  request: { id: RequestId; method: string; params: unknown },
): void {
  if (!activeClient) return;
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

function waitForTurn(activeClient: CodexAppServerClient, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Filesystem smoke turn timed out."));
    }, timeoutMs);
    const onNotification = (notification: { method: string; params: unknown }) => {
      if (notification.method !== "turn/completed" || !isRecord(notification.params)) return;
      const turn = isRecord(notification.params.turn) ? notification.params.turn : null;
      const status = turn && typeof turn.status === "string" ? turn.status : "completed";
      cleanup();
      if (status === "completed") resolve();
      else reject(new Error(`Filesystem smoke turn finished with status ${status}.`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      activeClient.off("notification", onNotification);
    };
    activeClient.on("notification", onNotification);
  });
}
