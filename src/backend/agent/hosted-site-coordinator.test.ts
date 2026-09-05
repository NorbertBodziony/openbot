import {
  type AgentEvent,
  hostedSiteConversationEvent,
  hostedSiteConversationEventItemType,
  hostedSiteConversationEventText,
} from "@openbot/contracts/ipc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentProvider } from "../agent-client";
import { AgentService } from "../agent-service";
import {
  FakeAgentClient,
  fakeBrowser,
  openBotToolPayload,
  startAgentTestFixture,
  stopAgentTestFixture,
  stores,
  waitFor,
} from "../agent-service-test-harness";

let root: string;
let service: AgentService | null = null;

beforeEach(async () => {
  ({ root } = await startAgentTestFixture());
});

afterEach(async () => {
  await stopAgentTestFixture(root, service);
  service = null;
});

describe.sequential("HostedSiteCoordinator: approval, mutation and markers", () => {
  it("requires user approval before an agent mutates hosted sites", async () => {
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores(root);
    const hostedSite = {
      id: "site-1",
      hostname: "approved-public-site-for-students-k7m2q9tzab.openbot.site",
      url: "http://approved-public-site-for-students-k7m2q9tzab.openbot.localhost:3100/",
      title: "Approved public site",
      description: "A public test site.",
      framework: "vanilla" as const,
      status: "active" as const,
      fileCount: 1,
      size: 20,
      expiresAt: "2026-09-30T12:00:00.000Z",
      updatedAt: "2026-08-31T12:00:00.000Z",
    };
    const hostedSites = {
      list: vi.fn(async () => [hostedSite]),
      publish: vi.fn(async () => hostedSite),
      replace: vi.fn(async () => hostedSite),
      delete: vi.fn(async () => undefined),
    };
    service = new AgentService(
      store,
      mailbox,
      fakeBrowser(),
      30_000,
      "codex",
      (provider) => {
        const client = new FakeAgentClient(provider, "", false);
        clients.set(provider, client);
        return client;
      },
      undefined,
      null,
      null,
      async () => undefined,
      hostedSites,
    );
    const events: AgentEvent[] = [];
    service.on("event", (event) => events.push(event));
    await service.initialize();
    const agent = await store.getOrCreate("chief");
    await service.sendMessage({ agentId: agent.id, text: "Publish my site." });
    await waitFor(() => events.some((event) => event.type === "turn-started"));
    const client = clients.get("codex");
    const threadId = store.activeProviderSession(agent.id)?.externalSessionId;
    const turnId = events.find((event) => event.type === "turn-started")?.turnId;
    if (!client || !threadId || !turnId) throw new Error("The hosted site approval turn did not start.");

    client.emit("request", {
      method: "item/tool/call",
      id: "invalid-site-approval",
      params: {
        threadId,
        turnId,
        callId: "invalid-site-approval",
        namespace: "openbot",
        tool: "publish_site",
        arguments: { title: "Hidden source", description: "This request has no source path." },
      },
    });
    await waitFor(() => client.errors.some((response) => response.id === "invalid-site-approval"));
    expect(service.getRuntimeSnapshot().pendingApprovals).toHaveLength(0);

    client.emit("request", {
      method: "item/tool/call",
      id: "publish-site-approval",
      params: {
        threadId,
        turnId,
        callId: "publish-site-approval",
        namespace: "openbot",
        tool: "publish_site",
        arguments: {
          sourcePath: agent.workspacePath,
          title: "Approved public site",
          description: "A public test site.",
        },
      },
    });
    await waitFor(() => events.some((event) => event.type === "approval"));
    expect(hostedSites.publish).not.toHaveBeenCalled();
    expect(client.responses).toHaveLength(0);
    expect(events.find((event) => event.type === "approval")).toMatchObject({
      approval: {
        kind: "permissions",
        reason: 'Publish "Approved public site" as a public site on openbot.site.',
        permissions: { fileSystem: { read: [agent.workspacePath], write: [] }, network: true },
      },
    });

    const appendConversationMessage = store.database.appendConversationMessage.bind(store.database);
    let failedTerminalAppend = false;
    let failRunningAppend = false;
    vi.spyOn(store.database, "appendConversationMessage").mockImplementation((input) => {
      if (failRunningAppend && input.message.itemType?.includes(":running:")) {
        throw new Error("Persistent marker write failure.");
      }
      if (!failedTerminalAppend && input.message.itemType?.includes(":succeeded:")) {
        failedTerminalAppend = true;
        throw new Error("Temporary marker write failure.");
      }
      return appendConversationMessage(input);
    });
    const accepted = service.respondToApproval({ requestId: "publish-site-approval", decision: "accept" });
    await expect(service.respondToApproval({ requestId: "publish-site-approval", decision: "accept" })).rejects.toThrow(
      "no longer active",
    );
    await accepted;
    expect(hostedSites.publish).toHaveBeenCalledTimes(1);
    expect(openBotToolPayload(client.responses[0]?.result)).toMatchObject({ id: "site-1", status: "active" });
    expect(
      (await service.readConversation(agent.id)).messages.flatMap(
        (message) => hostedSiteConversationEvent(message) ?? [],
      ),
    ).toEqual([
      expect.objectContaining({ action: "publish", status: "running", title: hostedSite.title }),
      expect.objectContaining({
        action: "publish",
        status: "succeeded",
        siteId: hostedSite.id,
        hostname: hostedSite.hostname,
        url: hostedSite.url,
      }),
    ]);

    client.emit("request", {
      method: "item/tool/call",
      id: "publish-site-persistence-failure",
      params: {
        threadId,
        turnId,
        callId: "publish-site-persistence-failure",
        namespace: "openbot",
        tool: "publish_site",
        arguments: {
          sourcePath: agent.workspacePath,
          title: "Unrecorded site",
          description: "This deploy must not start.",
        },
      },
    });
    await waitFor(() => service?.getRuntimeSnapshot().pendingApprovals.length === 1);
    failRunningAppend = true;
    await service.respondToApproval({ requestId: "publish-site-persistence-failure", decision: "accept" });
    failRunningAppend = false;
    expect(hostedSites.publish).toHaveBeenCalledTimes(1);
    expect(client.errors.at(-1)).toMatchObject({
      id: "publish-site-persistence-failure",
      error: { message: "The hosted site change could not be recorded." },
    });

    client.emit("request", {
      method: "item/tool/call",
      id: "delete-site-approval",
      params: {
        threadId,
        turnId,
        callId: "delete-site-approval",
        namespace: "openbot",
        tool: "delete_site",
        arguments: { siteId: "site-1" },
      },
    });
    await waitFor(() => service?.getRuntimeSnapshot().pendingApprovals.length === 1);
    expect(events.findLast((event) => event.type === "approval")).toMatchObject({
      approval: { reason: `Delete ${hostedSite.hostname} from openbot.site.` },
    });
    await service.respondToApproval({ requestId: "delete-site-approval", decision: "decline" });
    expect(hostedSites.delete).not.toHaveBeenCalled();
    expect(client.errors.at(-1)).toMatchObject({
      id: "delete-site-approval",
      error: { message: "The user declined this hosted site change." },
    });
    const markers = (await service.readConversation(agent.id)).messages.flatMap(
      (message) => hostedSiteConversationEvent(message) ?? [],
    );
    expect(markers.map(({ action, status }) => ({ action, status }))).toEqual([
      { action: "publish", status: "running" },
      { action: "publish", status: "succeeded" },
      { action: "delete", status: "cancelled" },
    ]);
    expect((await service.readConversationPageFor(agent.id, "member-1")).readState?.unreadCount).toBe(0);
    expect(service.searchConversationMessages(hostedSite.title, agent.id).total).toBe(0);
  });

  it("records failed site updates and successful site deletions as separate transitions", async () => {
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores(root);
    const hostedSite = {
      id: "site-1",
      hostname: "existing-site-23456789ab.openbot.site",
      url: "https://existing-site-23456789ab.openbot.site",
      title: "Existing site",
      description: "A public test site.",
      framework: "vanilla" as const,
      status: "active" as const,
      fileCount: 1,
      size: 20,
      expiresAt: "2026-09-30T12:00:00.000Z",
      updatedAt: "2026-08-31T12:00:00.000Z",
    };
    const hostedSites = {
      list: vi.fn(async () => [hostedSite]),
      publish: vi.fn(async () => hostedSite),
      replace: vi.fn(async () => {
        throw new Error("Upload failed.");
      }),
      delete: vi.fn(async () => undefined),
    };
    service = new AgentService(
      store,
      mailbox,
      fakeBrowser(),
      30_000,
      "codex",
      (provider) => {
        const client = new FakeAgentClient(provider, "", false);
        clients.set(provider, client);
        return client;
      },
      undefined,
      null,
      null,
      async () => undefined,
      hostedSites,
    );
    const events: AgentEvent[] = [];
    service.on("event", (event) => events.push(event));
    await service.initialize();
    const agent = await store.getOrCreate("chief");
    await service.sendMessage({ agentId: agent.id, text: "Update and remove my site." });
    await waitFor(() => events.some((event) => event.type === "turn-started"));
    const client = clients.get("codex");
    const threadId = store.activeProviderSession(agent.id)?.externalSessionId;
    const turnId = events.find((event) => event.type === "turn-started")?.turnId;
    if (!client || !threadId || !turnId) throw new Error("The hosted site transition turn did not start.");

    client.emit("request", {
      method: "item/tool/call",
      id: "replace-site-approval",
      params: {
        threadId,
        turnId,
        callId: "replace-site-approval",
        namespace: "openbot",
        tool: "replace_site",
        arguments: {
          siteId: hostedSite.id,
          sourcePath: agent.workspacePath,
          title: "Updated site",
          description: "Updated content.",
        },
      },
    });
    await waitFor(() => service?.getRuntimeSnapshot().pendingApprovals.length === 1);
    await service.respondToApproval({ requestId: "replace-site-approval", decision: "accept" });
    expect(hostedSites.replace).toHaveBeenCalledTimes(1);
    expect(client.errors.at(-1)).toMatchObject({
      id: "replace-site-approval",
      error: { message: "Error: Upload failed." },
    });

    client.emit("request", {
      method: "item/tool/call",
      id: "delete-site-success",
      params: {
        threadId,
        turnId,
        callId: "delete-site-success",
        namespace: "openbot",
        tool: "delete_site",
        arguments: { siteId: hostedSite.id },
      },
    });
    await waitFor(() => service?.getRuntimeSnapshot().pendingApprovals.length === 1);
    await service.respondToApproval({ requestId: "delete-site-success", decision: "accept" });
    expect(hostedSites.delete).toHaveBeenCalledTimes(1);

    const markers = (await service.readConversation(agent.id)).messages.flatMap(
      (message) => hostedSiteConversationEvent(message) ?? [],
    );
    expect(markers.map(({ action, status }) => ({ action, status }))).toEqual([
      { action: "replace", status: "running" },
      { action: "replace", status: "failed" },
      { action: "delete", status: "running" },
      { action: "delete", status: "succeeded" },
    ]);
    expect(markers[0]).toMatchObject({ title: "Updated site", hostname: hostedSite.hostname });
  });

  it("retries a durable hosted site result after restart without repeating the deploy", async () => {
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores(root);
    const hostedSite = {
      id: "site-durable-result",
      hostname: "durable-result-site-23456789ab.openbot.site",
      url: "https://durable-result-site-23456789ab.openbot.site",
      title: "Durable result site",
      description: "A public test site.",
      framework: "vanilla" as const,
      status: "active" as const,
      fileCount: 1,
      size: 20,
      expiresAt: "2026-09-30T12:00:00.000Z",
      updatedAt: "2026-08-31T12:00:00.000Z",
    };
    const hostedSites = {
      list: vi.fn(async () => [hostedSite]),
      publish: vi.fn(async () => hostedSite),
      replace: vi.fn(async () => hostedSite),
      delete: vi.fn(async () => undefined),
    };
    service = new AgentService(
      store,
      mailbox,
      fakeBrowser(),
      30_000,
      "codex",
      (provider) => {
        const client = new FakeAgentClient(provider, "", false);
        clients.set(provider, client);
        return client;
      },
      undefined,
      null,
      null,
      async () => undefined,
      hostedSites,
    );
    const events: AgentEvent[] = [];
    service.on("event", (event) => events.push(event));
    await service.initialize();
    const agent = await store.getOrCreate("chief");
    await service.sendMessage({ agentId: agent.id, text: "Publish my site." });
    await waitFor(() => events.some((event) => event.type === "turn-started"));
    const client = clients.get("codex");
    const threadId = store.activeProviderSession(agent.id)?.externalSessionId;
    const turnId = events.find((event) => event.type === "turn-started")?.turnId;
    if (!client || !threadId || !turnId) throw new Error("The hosted site retry test turn did not start.");

    client.emit("request", {
      method: "item/tool/call",
      id: "publish-site-durable-result",
      params: {
        threadId,
        turnId,
        callId: "publish-site-durable-result",
        namespace: "openbot",
        tool: "publish_site",
        arguments: {
          sourcePath: agent.workspacePath,
          title: hostedSite.title,
          description: hostedSite.description,
        },
      },
    });
    await waitFor(() => service?.getRuntimeSnapshot().pendingApprovals.length === 1);
    const appendConversationMessage = store.database.appendConversationMessage.bind(store.database);
    const appendSpy = vi.spyOn(store.database, "appendConversationMessage").mockImplementation((input) => {
      if (input.message.itemType?.includes(":succeeded:")) {
        throw new Error("The terminal marker store is temporarily unavailable.");
      }
      return appendConversationMessage(input);
    });
    const pendingSpy = vi.spyOn(store.database, "recordPendingHostedSiteTerminalEvent").mockImplementation(() => {
      throw new Error("The terminal outbox is temporarily unavailable.");
    });
    await service.respondToApproval({ requestId: "publish-site-durable-result", decision: "accept" });

    expect(hostedSites.publish).toHaveBeenCalledTimes(1);
    expect(client.responses).toHaveLength(0);
    expect(
      (await service.readConversation(agent.id)).messages
        .flatMap((message) => hostedSiteConversationEvent(message) ?? [])
        .map((marker) => marker.status),
    ).toEqual(["running"]);
    expect(store.database.activeHostedSiteConversationEvents()).toHaveLength(1);
    expect(store.database.pendingHostedSiteTerminalEvents()).toEqual([]);

    pendingSpy.mockRestore();
    await waitFor(() => client.responses.length === 1);
    expect(store.database.pendingHostedSiteTerminalEvents()).toEqual([
      expect.objectContaining({ action: "publish", status: "succeeded" }),
    ]);

    appendSpy.mockRestore();
    await service.stop();
    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();

    expect(hostedSites.publish).toHaveBeenCalledTimes(1);
    expect(
      (await service.readConversation(agent.id)).messages
        .flatMap((message) => hostedSiteConversationEvent(message) ?? [])
        .map((marker) => marker.status),
    ).toEqual(["running", "succeeded"]);
    expect(store.database.pendingHostedSiteTerminalEvents()).toEqual([]);
    expect(store.database.activeHostedSiteConversationEvents()).toEqual([]);
  });

  it("normalizes legacy hosted site metadata without blocking deletion", async () => {
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores(root);
    const hostedSite = {
      id: "legacy-site",
      hostname: "legacy.example.com",
      url: "http://legacy.example.com",
      title: "",
      description: "A legacy site.",
      framework: "vanilla" as const,
      status: "active" as const,
      fileCount: 1,
      size: 20,
      expiresAt: "2026-09-30T12:00:00.000Z",
      updatedAt: "2026-08-31T12:00:00.000Z",
    };
    const hostedSites = {
      list: vi.fn(async () => [hostedSite]),
      publish: vi.fn(async () => hostedSite),
      replace: vi.fn(async () => hostedSite),
      delete: vi.fn(async () => undefined),
    };
    service = new AgentService(
      store,
      mailbox,
      fakeBrowser(),
      30_000,
      "codex",
      (provider) => {
        const client = new FakeAgentClient(provider, "", false);
        clients.set(provider, client);
        return client;
      },
      undefined,
      null,
      null,
      async () => undefined,
      hostedSites,
    );
    const events: AgentEvent[] = [];
    service.on("event", (event) => events.push(event));
    await service.initialize();
    const agent = await store.getOrCreate("chief");
    await service.sendMessage({ agentId: agent.id, text: "Delete my old site." });
    await waitFor(() => events.some((event) => event.type === "turn-started"));
    const client = clients.get("codex");
    const threadId = store.activeProviderSession(agent.id)?.externalSessionId;
    const turnId = events.find((event) => event.type === "turn-started")?.turnId;
    if (!client || !threadId || !turnId) throw new Error("The legacy hosted site test turn did not start.");

    client.emit("request", {
      method: "item/tool/call",
      id: "delete-legacy-site",
      params: {
        threadId,
        turnId,
        callId: "delete-legacy-site",
        namespace: "openbot",
        tool: "delete_site",
        arguments: { siteId: hostedSite.id },
      },
    });
    await waitFor(() => service?.getRuntimeSnapshot().pendingApprovals.length === 1);
    await service.respondToApproval({ requestId: "delete-legacy-site", decision: "accept" });

    expect(hostedSites.delete).toHaveBeenCalledTimes(1);
    const markers = (await service.readConversation(agent.id)).messages.flatMap(
      (message) => hostedSiteConversationEvent(message) ?? [],
    );
    expect(markers.map((marker) => marker.status)).toEqual(["running", "succeeded"]);
    expect(markers[0]).toMatchObject({
      siteId: hostedSite.id,
      title: hostedSite.hostname,
      hostname: null,
      url: null,
    });
  });

  it("interrupts an unfinished hosted site marker after restart", async () => {
    const { store, mailbox } = stores(root);
    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();
    const agent = await store.getOrCreate("chief");
    const threadId = store.ensureThreadIdNow(agent.id);
    const details = { siteId: null, title: "Restarted deploy", hostname: null, url: null };
    store.database.appendConversationMessage({
      agentId: agent.id,
      threadId,
      activeTurnId: null,
      message: {
        id: "hosted-site-event:operation-restart:running",
        turnId: "turn-restart",
        author: "system",
        source: "system",
        text: hostedSiteConversationEventText(details),
        createdAt: "2026-09-01T12:00:00.000Z",
        status: "completed",
        itemType: hostedSiteConversationEventItemType("publish", "running", "operation-restart"),
      },
      eventType: "hosted-site.publish-running",
      commandId: "hosted-site-event:operation-restart:running",
    });
    store.database.recordActiveHostedSiteConversationEvent({
      agentId: agent.id,
      threadId,
      turnId: "turn-restart",
      createdAt: "2026-09-01T12:00:00.000Z",
      event: { action: "publish", status: "running", operationId: "operation-restart", ...details },
    });

    await service.stop();
    service = new AgentService(store, mailbox, fakeBrowser());
    await service.initialize();
    const markers = (await service.readConversation(agent.id)).messages.flatMap(
      (message) => hostedSiteConversationEvent(message) ?? [],
    );
    expect(markers.map((marker) => marker.status)).toEqual(["running", "interrupted"]);
    expect(markers[1]).toMatchObject({ action: "publish", title: details.title, operationId: "operation-restart" });
  });

  it("keeps a successful hosted site result when the provider response cannot be delivered", async () => {
    const clients = new Map<AgentProvider, FakeAgentClient>();
    const { store, mailbox } = stores(root);
    const hostedSite = {
      id: "site-response-failure",
      hostname: "response-failure-site-23456789ab.openbot.site",
      url: "https://response-failure-site-23456789ab.openbot.site",
      title: "Response failure site",
      description: "A public test site.",
      framework: "vanilla" as const,
      status: "active" as const,
      fileCount: 1,
      size: 20,
      expiresAt: "2026-09-30T12:00:00.000Z",
      updatedAt: "2026-08-31T12:00:00.000Z",
    };
    const hostedSites = {
      list: vi.fn(async () => [hostedSite]),
      publish: vi.fn(async () => hostedSite),
      replace: vi.fn(async () => hostedSite),
      delete: vi.fn(async () => undefined),
    };
    service = new AgentService(
      store,
      mailbox,
      fakeBrowser(),
      30_000,
      "codex",
      (provider) => {
        const client = new FakeAgentClient(provider, "", false);
        clients.set(provider, client);
        return client;
      },
      undefined,
      null,
      null,
      async () => undefined,
      hostedSites,
    );
    const events: AgentEvent[] = [];
    service.on("event", (event) => events.push(event));
    await service.initialize();
    const agent = await store.getOrCreate("chief");
    await service.sendMessage({ agentId: agent.id, text: "Publish my site." });
    await waitFor(() => events.some((event) => event.type === "turn-started"));
    const client = clients.get("codex");
    const threadId = store.activeProviderSession(agent.id)?.externalSessionId;
    const turnId = events.find((event) => event.type === "turn-started")?.turnId;
    if (!client || !threadId || !turnId) throw new Error("The hosted site response test turn did not start.");

    client.emit("request", {
      method: "item/tool/call",
      id: "publish-site-response-failure",
      params: {
        threadId,
        turnId,
        callId: "publish-site-response-failure",
        namespace: "openbot",
        tool: "publish_site",
        arguments: {
          sourcePath: agent.workspacePath,
          title: hostedSite.title,
          description: hostedSite.description,
        },
      },
    });
    await waitFor(() => service?.getRuntimeSnapshot().pendingApprovals.length === 1);
    client.responseError = new Error("The provider connection closed.");
    await service.respondToApproval({ requestId: "publish-site-response-failure", decision: "accept" });

    expect(hostedSites.publish).toHaveBeenCalledTimes(1);
    expect(
      (await service.readConversation(agent.id)).messages
        .flatMap((message) => hostedSiteConversationEvent(message) ?? [])
        .map((marker) => marker.status),
    ).toEqual(["running", "succeeded"]);
  });
});
