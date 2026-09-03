import { describe, expect, it } from "vitest";
import {
  decodeAccountUsage,
  decodeAgentModels,
  decodeAgentPublicationPreview,
  decodeAgentStatus,
  decodeAgentSubmission,
  decodeAgentSubmissions,
  decodeAttachments,
  decodeBot,
  decodeBots,
  decodeBrowserPreview,
  decodeComputerUseMacSetupState,
  decodeConversation,
  decodeConversationPage,
  decodeConversationSearchPage,
  decodeDraftAttachments,
  decodeDuplicateBotResult,
  decodeDynamicIslandAction,
  decodeDynamicIslandGeometry,
  decodeDynamicIslandPreference,
  decodeDynamicIslandPresentation,
  decodeFilePreview,
  decodeHostedSite,
  decodeHostedSites,
  decodeInstalledSkill,
  decodeInstalledSkills,
  decodeMarketplaceAgentDetail,
  decodeMarketplaceAgentPage,
  decodeMemories,
  decodeMemory,
  decodeNullablePath,
  decodeProviderRuntimeSnapshot,
  decodeQueue,
  decodeReadState,
  decodeReadStates,
  decodeReceipt,
  decodeRoutine,
  decodeRoutineRun,
  decodeRoutineRuns,
  decodeRoutines,
  decodeSidebarLayout,
  decodeSkillDetail,
  decodeSkillPage,
  decodeSkillPreview,
  decodeSubmission,
  decodeSubmissions,
  decodeVoid,
} from "./ipc-decoders";

const bot = {
  id: "bot-1",
  name: "Helper",
  title: "Generalist",
  description: "Helps out.",
  notifications: true,
  model: "gpt-5.6-luna",
  reasoningEffort: "medium",
  threadId: null,
  workspacePath: "/mock/workspace",
  preview: "Hello",
  updatedAt: null,
  avatarSeed: "abc",
  avatarHue: null,
  avatarUrl: null,
};

const memory = {
  id: "mem-1",
  botId: "bot-1",
  text: "Prefers short answers.",
  origin: "manual",
  sourceTurnId: null,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};

const layout = { revision: 0, sections: [], order: [], agentAssignments: {}, agentOrder: [] };

const schedule = { kind: "daily", time: "09:00" };
const routine = {
  id: "routine-1",
  botId: "bot-1",
  name: "Standup",
  instruction: "Summarize inbox.",
  active: true,
  timezone: "UTC",
  trigger: {
    id: "trigger-1",
    routineId: "routine-1",
    schedule,
    nextRunAt: "2026-01-02T09:00:00Z",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  },
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};

const routineRun = {
  id: "run-1",
  routineId: "routine-1",
  botId: "bot-1",
  triggerId: null,
  kind: "manual",
  scheduledFor: "2026-01-02T09:00:00Z",
  routineName: "Standup",
  instruction: "Summarize inbox.",
  deliveryId: null,
  status: "succeeded",
  error: null,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};

const readState = { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: null };

describe("ipc response decoders", () => {
  it("accepts empty responses and rejects unexpected data", () => {
    expect(decodeVoid(undefined)).toBeUndefined();
    expect(decodeVoid(null)).toBeUndefined();
    expect(() => decodeVoid({})).toThrow();
    expect(decodeNullablePath(null)).toBeNull();
    expect(decodeNullablePath("/tmp")).toBe("/tmp");
    expect(() => decodeNullablePath(5)).toThrow();
  });

  it("decodes computer setup state and dynamic island payloads", () => {
    const setup = { status: "available", helperName: "Helper", helperIconDataUrl: null, message: null };
    expect(decodeComputerUseMacSetupState(setup)).toEqual(setup);
    expect(() => decodeComputerUseMacSetupState({ ...setup, status: "maybe" })).toThrow();

    const preference = { enabled: true, hapticsEnabled: true, idleVisible: true, additionalDisplaysEnabled: false };
    expect(decodeDynamicIslandPreference(preference)).toEqual(preference);
    expect(() => decodeDynamicIslandPreference({})).toThrow();
    expect(decodeDynamicIslandGeometry(null)).toBeNull();
    expect(decodeDynamicIslandGeometry({ width: 100, height: 30 })).toEqual({ width: 100, height: 30 });
    expect(() => decodeDynamicIslandGeometry({ width: -1, height: 30 })).toThrow();
    const presentation = { serverId: "local", mode: "idle" };
    expect(decodeDynamicIslandPresentation(presentation)).toEqual(presentation);
    expect(() => decodeDynamicIslandPresentation({ mode: "idle" })).toThrow();
    expect(decodeDynamicIslandAction({ type: "open-app" })).toEqual({ type: "open-app" });
    expect(() => decodeDynamicIslandAction({ type: "nope" })).toThrow();
  });

  it("validates browser previews and hosted sites", () => {
    const preview = { dataUrl: "data:image/jpeg;base64,QUJD", width: 100, height: 100 };
    expect(decodeBrowserPreview(preview)).toEqual(preview);
    expect(() => decodeBrowserPreview({ ...preview, width: 5000 })).toThrow();

    const site = {
      id: "site-1",
      hostname: "site.openbot.site",
      url: "https://site.openbot.site",
      title: "Site",
      description: "A site.",
      framework: "vanilla",
      status: "active",
      fileCount: 3,
      size: 120,
      expiresAt: null,
      updatedAt: "2026-01-01",
    };
    expect(decodeHostedSite(site)).toEqual(site);
    expect(decodeHostedSites([site])).toEqual([site]);
    expect(() => decodeHostedSite({ ...site, framework: "next" })).toThrow();
    expect(() => decodeHostedSites({})).toThrow();
  });

  it("decodes agents, memories, layouts, and duplication results", () => {
    expect(decodeBot(bot)).toEqual(bot);
    expect(decodeBots([bot])).toEqual([bot]);
    expect(() => decodeBot({ ...bot, model: "" })).toThrow();
    expect(decodeMemory(memory)).toEqual(memory);
    expect(decodeMemories([memory])).toEqual([memory]);
    expect(() => decodeMemory({ ...memory, origin: "system" })).toThrow();
    expect(decodeSidebarLayout(layout)).toEqual(layout);
    expect(() => decodeSidebarLayout({ ...layout, revision: "0" })).toThrow();
    expect(decodeDuplicateBotResult({ bot, layout })).toEqual({ bot, layout });
    expect(() => decodeDuplicateBotResult({ bot })).toThrow();
  });

  it("decodes routines and routine runs", () => {
    expect(decodeRoutine(routine)).toEqual(routine);
    expect(decodeRoutines([routine])).toEqual([routine]);
    expect(() => decodeRoutine({ ...routine, active: "yes" })).toThrow();
    expect(decodeRoutineRun(routineRun)).toEqual(routineRun);
    expect(decodeRoutineRuns([routineRun])).toEqual([routineRun]);
    expect(() => decodeRoutineRun({ ...routineRun, status: "unknown" })).toThrow();
  });

  it("decodes conversations, pages, search results, and read states", () => {
    const conversation = { botId: "bot-1", threadId: null, activeTurnId: null, revision: 1, messages: [], readState };
    expect(decodeConversation(conversation)).toEqual(conversation);
    expect(() => decodeConversation({ ...conversation, readState: null })).toThrow();

    const page = {
      botId: "bot-1",
      threadId: null,
      activeTurnId: null,
      revision: 2,
      messages: [],
      references: {},
      pageInfo: { hasOlder: false, olderCursor: null },
    };
    expect(decodeConversationPage(page)).toEqual(page);
    expect(() => decodeConversationPage({ ...page, pageInfo: {} })).toThrow();

    const search = { results: [], total: 0, nextCursor: null };
    expect(decodeConversationSearchPage(search)).toEqual(search);
    expect(() => decodeConversationSearchPage({ ...search, total: "0" })).toThrow();

    expect(decodeReadState(readState)).toEqual(readState);
    expect(() => decodeReadState({ ...readState, unreadCount: "0" })).toThrow();
    expect(decodeReadStates({ "bot-1": readState })).toEqual({ "bot-1": readState });
  });

  it("decodes attachments, receipts, queues, and file previews", () => {
    expect(decodeAttachments([])).toEqual([]);
    expect(decodeDraftAttachments([])).toEqual([]);
    expect(() => decodeAttachments([{}])).toThrow();
    const receipt = { messageId: "msg-1", deliveries: [] };
    expect(decodeReceipt(receipt)).toEqual(receipt);
    expect(() => decodeReceipt({})).toThrow();
    const queue = { botId: "bot-1", deliveries: [] };
    expect(decodeQueue(queue)).toEqual(queue);
    expect(() => decodeQueue({})).toThrow();
    const preview = { name: "a.txt", size: 3, mimeType: "text/plain", previewKind: "text", bytes: null };
    expect(decodeFilePreview(preview)).toEqual(preview);
    expect(() => decodeFilePreview({ ...preview, previewKind: "video" })).toThrow();
  });

  it("decodes status, usage, models, and provider runtimes", () => {
    const status = {
      phase: "idle",
      cliVersion: null,
      auth: { kind: "oauth" },
      capabilities: { chat: "ready", browser: "ready", computerUse: "unavailable" },
      message: null,
      fullAccess: true,
    };
    expect(decodeAgentStatus(status)).toEqual(status);
    expect(() => decodeAgentStatus({ ...status, fullAccess: false })).toThrow();

    expect(decodeAccountUsage({ limits: [] })).toEqual({ limits: [] });
    expect(() => decodeAccountUsage({ limits: [{ id: 1 }] })).toThrow();

    const models = [
      {
        provider: "codex",
        id: "gpt-5.6-luna",
        name: "Luna",
        description: "Fast.",
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: ["medium"],
      },
    ];
    expect(decodeAgentModels(models)).toEqual(models);
    expect(() => decodeAgentModels([{ ...models[0], defaultReasoningEffort: "ultra" }])).toThrow();

    const runtime = {
      revision: 2,
      providers: {
        codex: { phase: "ready", progress: null, message: null, version: "1" },
        claude: { phase: "ready", progress: null, message: null, version: "1" },
        grok: { phase: "ready", progress: null, message: null, version: "1" },
      },
    };
    expect(decodeProviderRuntimeSnapshot(runtime)).toEqual(runtime);
    expect(() => decodeProviderRuntimeSnapshot({ revision: 1, providers: {} })).toThrow();
  });

  it("decodes marketplace skills and agents", () => {
    const summary = {
      id: "skill-1",
      slug: "notes",
      name: "Notes",
      description: "Take notes.",
      category: "productivity",
      creatorName: "An",
      version: 2,
      installs: 10,
      featured: false,
      iconUrl: null,
      updatedAt: "2026-01-01",
    };
    expect(decodeSkillPage({ skills: [summary], nextCursor: null }).skills).toEqual([summary]);
    expect(() => decodeSkillPage({ skills: [{ ...summary, category: "fun" }], nextCursor: null })).toThrow();
    const detail = { ...summary, versionId: "v2", bundleSha256: "abc", files: ["SKILL.md"], instructions: "Do." };
    expect(decodeSkillDetail(detail)).toEqual(detail);
    const submission = {
      id: "sub-1",
      skillId: "skill-1",
      slug: "notes",
      name: "Notes",
      description: "Take notes.",
      category: "productivity",
      version: 2,
      status: "pending",
      rejectionNote: null,
      iconUrl: null,
      createdAt: "2026-01-01",
    };
    expect(decodeSubmission(submission)).toEqual(submission);
    expect(decodeSubmissions([submission])).toEqual([submission]);
    expect(decodeSkillPreview(null)).toBeNull();
    expect(() => decodeSkillPreview({})).toThrow();
    const installed = {
      skillId: "skill-1",
      slug: "notes",
      name: "Notes",
      installedVersion: 1,
      availableVersion: 2,
      state: "installed",
    };
    expect(decodeInstalledSkill(installed)).toEqual(installed);
    expect(decodeInstalledSkills([installed])).toEqual([installed]);
    expect(() => decodeInstalledSkill({ ...installed, state: "broken" })).toThrow();

    const agentSummary = {
      id: "agent-1",
      name: "Helper",
      title: "Generalist",
      description: "Helps.",
      creatorName: "An",
      version: 1,
      installs: 4,
      featured: false,
      avatarSeed: "abc",
      avatarHue: null,
      avatarUrl: null,
      skillCount: 1,
      routineCount: 1,
      activeRoutineCount: 1,
      updatedAt: "2026-01-01",
    };
    expect(decodeMarketplaceAgentPage({ agents: [agentSummary], nextCursor: null }).agents).toEqual([agentSummary]);
    const agentDetail = {
      ...agentSummary,
      versionId: "v1",
      skills: [{ skillId: "skill-1", versionId: "v1", slug: "notes", name: "Notes", version: 1 }],
      routines: [{ name: "Standup", instruction: "Summarize.", active: true, schedule }],
    };
    expect(decodeMarketplaceAgentDetail(agentDetail)).toEqual(agentDetail);
    expect(() => decodeMarketplaceAgentDetail({ ...agentDetail, routines: [{ name: "x" }] })).toThrow();

    const agentSubmission = {
      id: "asub-1",
      agentId: "agent-1",
      name: "Helper",
      title: "Generalist",
      description: "Helps.",
      version: 1,
      status: "pending",
      rejectionNote: null,
      avatarSeed: "abc",
      avatarHue: null,
      avatarUrl: null,
      skillCount: 1,
      routineCount: 1,
      activeRoutineCount: 1,
      createdAt: "2026-01-01",
    };
    expect(decodeAgentSubmission(agentSubmission)).toEqual(agentSubmission);
    expect(decodeAgentSubmissions([agentSubmission])).toEqual([agentSubmission]);
    expect(() => decodeAgentSubmission({ ...agentSubmission, status: "draft" })).toThrow();

    const previewInput = {
      botId: "bot-1",
      name: "Helper",
      title: "Generalist",
      description: "Helps.",
      avatarSeed: "abc",
      avatarHue: null,
      avatarUrl: null,
      skills: agentDetail.skills,
      routines: agentDetail.routines,
    };
    const preview = decodeAgentPublicationPreview(previewInput);
    expect(preview.botId).toBe("bot-1");
    expect(preview.skills).toEqual(agentDetail.skills);
    expect(() => decodeAgentPublicationPreview({ ...previewInput, avatarSeed: "BAD SEED!" })).toThrow();
  });
});
