// @vitest-environment node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { afterEach, describe, expect, it } from "vitest";
import { type DynamicToolNamespace, LocalMcpBridge } from "./local-mcp-bridge";

const TOOLS: DynamicToolNamespace[] = [
  {
    type: "namespace" as const,
    name: "openbot",
    description: "OpenBot test tools",
    tools: [
      {
        type: "function" as const,
        name: "echo",
        description: "Echo text or an image.",
        inputSchema: {
          type: "object",
          properties: { image: { type: "boolean" } },
          additionalProperties: false,
        },
      },
    ],
  },
];

const bridges: LocalMcpBridge[] = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  await Promise.allSettled(bridges.splice(0).map((bridge) => bridge.close()));
});

describe("LocalMcpBridge", () => {
  it("requires its session token, isolates sessions, and forwards text and image results", async () => {
    const bridge = new LocalMcpBridge();
    bridges.push(bridge);
    const calls: string[] = [];
    const first = await bridge.createSession(
      "thread-1",
      TOOLS,
      () => "turn-1",
      async (call) => {
        calls.push(`${call.threadId}:${call.turnId}`);
        return isDynamicRecord(call.arguments) && "image" in call.arguments
          ? {
              success: true,
              contentItems: [{ type: "inputImage", imageUrl: "data:image/png;base64,aGVsbG8=" }],
            }
          : { success: true, contentItems: [{ type: "inputText", text: "hello" }] };
      },
    );
    const second = await bridge.createSession(
      "thread-2",
      TOOLS,
      () => "turn-2",
      async () => ({
        success: true,
        contentItems: [{ type: "inputText", text: "second" }],
      }),
    );

    const firstClient = await connect(first.servers[0]);
    const secondClient = await connect(second.servers[0]);
    expect((await firstClient.listTools()).tools.map((tool) => tool.name)).toEqual(["echo"]);
    expect(await firstClient.callTool({ name: "echo", arguments: {} })).toMatchObject({
      content: [{ type: "text", text: "hello" }],
    });
    expect(await firstClient.callTool({ name: "echo", arguments: { image: true } })).toMatchObject({
      content: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }],
    });
    expect(await secondClient.callTool({ name: "echo", arguments: {} })).toMatchObject({
      content: [{ type: "text", text: "second" }],
    });
    expect(calls).toEqual(["thread-1:turn-1", "thread-1:turn-1"]);

    const unauthorized = new Client({ name: "unauthorized", version: "1" });
    clients.push(unauthorized);
    await expect(
      unauthorized.connect(
        new StreamableHTTPClientTransport(new URL(first.servers[0].url), {
          requestInit: { headers: { Authorization: "Bearer wrong-token" } },
        }),
      ),
    ).rejects.toThrow();

    await firstClient.close();
    first.close();
    const closed = new Client({ name: "closed", version: "1" });
    clients.push(closed);
    await expect(
      closed.connect(
        new StreamableHTTPClientTransport(new URL(first.servers[0].url), {
          requestInit: {
            headers: Object.fromEntries(first.servers[0].headers.map((header) => [header.name, header.value])),
          },
        }),
      ),
    ).rejects.toThrow();
  });
});

async function connect(server: { url: string; headers: Array<{ name: string; value: string }> }): Promise<Client> {
  const client = new Client({ name: "openbot-test", version: "1" });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: Object.fromEntries(server.headers.map((header) => [header.name, header.value])) },
    }),
  );
  return client;
}
