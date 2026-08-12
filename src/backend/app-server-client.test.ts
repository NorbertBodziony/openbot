// @vitest-environment node

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAppServerClient } from "./app-server-client";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("CodexAppServerClient", () => {
  it("matches responses and receives notifications over stdio", async () => {
    const executable = await createFakeCodex();
    const client = new CodexAppServerClient(executable, 2_000);
    const notifications: string[] = [];
    client.on("notification", (notification) => notifications.push(notification.method));
    client.start();

    const result = await client.request<{ echoed: string }>("test/echo", { text: "hello" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(result).toEqual({ echoed: "hello" });
    expect(notifications).toContain("test/notification");
    await client.stop();
  });

  it("rejects timed out requests", async () => {
    const executable = await createFakeCodex();
    const client = new CodexAppServerClient(executable, 30);
    client.start();

    await expect(client.request("test/timeout", {})).rejects.toThrow("timed out");
    await client.stop();
  });
});

async function createFakeCodex(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "infeld-fake-codex-"));
  temporaryRoots.push(root);
  const executable = join(root, "codex");
  await writeFile(
    executable,
    `#!/usr/bin/env node
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line) {
      const message = JSON.parse(line);
      if (message.method === "test/echo") {
        const response = JSON.stringify({ id: message.id, result: { echoed: message.params.text } }) + "\\n";
        const middle = Math.floor(response.length / 2);
        process.stdout.write(response.slice(0, middle));
        process.stdout.write(response.slice(middle));
        process.stdout.write(JSON.stringify({ method: "test/notification", params: {} }) + "\\n");
      }
    }
    newline = buffer.indexOf("\\n");
  }
});
`,
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  return executable;
}
