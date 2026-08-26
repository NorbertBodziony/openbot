import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  type JSONRPCMessage,
  JSONRPCMessageSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { isString } from "@openbot/contracts/runtime-values";
import type { DynamicToolResult } from "./protocol";

export interface DynamicToolDefinition {
  type: "function";
  name: string;
  description?: string;
  inputSchema: Tool["inputSchema"];
}

export interface DynamicToolNamespace {
  type: "namespace";
  name: string;
  description?: string;
  tools: DynamicToolDefinition[];
}

export interface LocalMcpSession {
  readonly servers: Array<{
    type: "http";
    name: string;
    url: string;
    headers: Array<{ name: string; value: string }>;
  }>;
  setThreadId(threadId: string): void;
  close(): void;
}

interface BridgeRoute {
  namespace: DynamicToolNamespace;
  threadId: string;
  call: (params: {
    threadId: string;
    turnId: string;
    callId: string;
    namespace: string;
    tool: string;
    arguments: unknown;
  }) => Promise<DynamicToolResult>;
  activeTurnId: () => string | null;
}

export class LocalMcpBridge {
  #server: HttpServer | null = null;
  #port: number | null = null;
  readonly #routes = new Map<string, BridgeRoute>();

  async createSession(
    threadId: string,
    namespaces: DynamicToolNamespace[],
    activeTurnId: () => string | null,
    call: BridgeRoute["call"],
  ): Promise<LocalMcpSession> {
    await this.#listen();
    const tokens: string[] = [];
    const servers = namespaces.map((namespace) => {
      const token = randomBytes(32).toString("base64url");
      tokens.push(token);
      this.#routes.set(token, { namespace, threadId, activeTurnId, call });
      return {
        type: "http" as const,
        name: namespace.name,
        url: `http://127.0.0.1:${this.#port}/mcp`,
        headers: [{ name: "Authorization", value: `Bearer ${token}` }],
      };
    });
    return {
      servers,
      setThreadId: (nextThreadId) => {
        for (const token of tokens) {
          const route = this.#routes.get(token);
          if (route) route.threadId = nextThreadId;
        }
      },
      close: () => {
        for (const token of tokens) this.#routes.delete(token);
      },
    };
  }

  async close(): Promise<void> {
    this.#routes.clear();
    const server = this.#server;
    this.#server = null;
    this.#port = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async #listen(): Promise<void> {
    if (this.#server) return;
    const server = createServer((request, response) => void this.#handle(request, response));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || isString(address)) {
      server.close();
      throw new Error("Unable to bind the local OpenBot MCP bridge.");
    }
    this.#server = server;
    this.#port = address.port;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const route = this.#authorize(request);
    if (!route) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST" });
      response.end();
      return;
    }

    const mcp = new Server(
      { name: route.namespace.name, version: "0.1.0" },
      { capabilities: { tools: {} }, instructions: route.namespace.description },
    );
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: route.namespace.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    }));
    mcp.setRequestHandler(CallToolRequestSchema, async ({ params }): Promise<CallToolResult> => {
      const tool = route.namespace.tools.find((candidate) => candidate.name === params.name);
      if (!tool) throw new Error(`Unknown ${route.namespace.name} tool: ${params.name}`);
      const result = await route.call({
        threadId: route.threadId,
        turnId: route.activeTurnId() ?? randomUUID(),
        callId: randomUUID(),
        namespace: route.namespace.name,
        tool: tool.name,
        arguments: params.arguments ?? {},
      });
      const content: CallToolResult["content"] = [];
      for (const item of result.contentItems) {
        if (item.type === "inputText") {
          content.push({ type: "text", text: item.text });
          continue;
        }
        const match = item.imageUrl.match(/^data:([^;]+);base64,(.+)$/s);
        if (match) content.push({ type: "image", mimeType: match[1], data: match[2] });
      }
      return {
        isError: !result.success,
        content,
      };
    });

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(request, response, await readJsonBody(request));
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: String(error) } }));
      }
    } finally {
      await transport.close().catch(() => undefined);
      await mcp.close().catch(() => undefined);
    }
  }

  #authorize(request: IncomingMessage): BridgeRoute | null {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) return null;
    const candidate = header.slice(7);
    for (const [token, route] of this.#routes) {
      const left = Buffer.from(candidate);
      const right = Buffer.from(token);
      if (left.length === right.length && timingSafeEqual(left, right)) return route;
    }
    return null;
  }
}

async function readJsonBody(request: IncomingMessage): Promise<JSONRPCMessage | JSONRPCMessage[] | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new Error("MCP request body is too large.");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (Array.isArray(value)) {
    return value.map((item) => {
      const parsed = JSONRPCMessageSchema.safeParse(item);
      if (!parsed.success) throw new Error("Invalid MCP JSON-RPC message.");
      return parsed.data;
    });
  }
  const parsed = JSONRPCMessageSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid MCP JSON-RPC message.");
  return parsed.data;
}
