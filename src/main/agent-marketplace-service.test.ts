import type { AgentSummary, MarketplaceAgentDetail } from "@openbot/contracts/ipc";
import { describe, expect, it, vi } from "vitest";
import { AgentMarketplaceService } from "./agent-marketplace-service";

const intervalSchedule = { kind: "interval", amount: 1, unit: "days", anchorAt: "2026-01-01T00:00:00.000Z" } as const;

const agent: AgentSummary = {
  id: "bot-writer",
  name: "Writer",
  title: "Editorial partner",
  description: "Drafts and edits product writing.",
  notifications: true,
  provider: "codex",
  model: "gpt-5.6-luna",
  reasoningEffort: "medium",
  threadId: null,
  workspacePath: "/tmp/bot-writer",
  preview: "Private conversation preview",
  updatedAt: null,
  avatarSeed: "bot-writer",
  avatarHue: 215,
  avatarUrl: null,
};

const detail: MarketplaceAgentDetail = {
  id: "market-writer",
  versionId: "market-writer-v2",
  name: agent.name,
  title: agent.title,
  description: agent.description,
  creatorName: "Ada",
  version: 2,
  installs: 0,
  featured: false,
  avatarSeed: agent.avatarSeed,
  avatarHue: agent.avatarHue,
  avatarUrl: null,
  skillCount: 1,
  routineCount: 1,
  activeRoutineCount: 1,
  updatedAt: "2026-08-26T00:00:00.000Z",
  skills: [{ skillId: "editing", versionId: "editing-v2", slug: "editing", name: "Editing", version: 2 }],
  routines: [
    {
      name: "Editorial brief",
      instruction: "Prepare the daily editorial brief.",
      active: true,
      schedule: intervalSchedule,
    },
  ],
};

function service(overrides: { failSkill?: boolean } = {}) {
  const agents = {
    listAgents: vi.fn(() => [agent]),
    listRoutines: vi.fn(() => [
      {
        id: "routine-private-id",
        agentId: agent.id,
        name: "Editorial brief",
        instruction: "Prepare the daily editorial brief.",
        active: true,
        timezone: "Europe/Warsaw",
        trigger: { id: "trigger-private-id", routineId: "routine-private-id", schedule: intervalSchedule },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]),
    resolveAvatar: vi.fn(() => null),
    createAgentProfile: vi.fn(async () => agent),
    updateAgent: vi.fn(async () => agent),
    setAvatar: vi.fn(async () => agent),
    createRoutine: vi.fn(() => ({ id: "routine-marketplace-id" })),
    deleteRoutine: vi.fn(async () => undefined),
    setMarketplaceSource: vi.fn((_agentId, source) => ({ ...agent, marketplaceSource: source })),
    deleteAgent: vi.fn(async () => undefined),
  };
  const skills = {
    listPublishable: vi.fn(async () => detail.skills),
    uninstall: vi.fn(async () => undefined),
    installVersion: overrides.failSkill
      ? vi.fn(async () => {
          throw new Error("skill failed");
        })
      : vi.fn(async () => undefined),
  };
  const auth = {
    async requestAuthorized<T>(path: string, _init: RequestInit, decoder: (value: unknown) => T): Promise<T> {
      return decoder(path.endsWith("/install") ? { installed: true } : detail);
    },
    resolveApiUrl(value: string) {
      return value;
    },
    async downloadAuthorized() {
      return new Uint8Array();
    },
  };
  return {
    agents,
    skills,
    marketplace: new AgentMarketplaceService(auth, agents, skills),
  };
}

describe("AgentMarketplaceService", () => {
  it("publishes only the public profile, approved skills, and routine definitions", async () => {
    const { marketplace } = service();
    const preview = await marketplace.preview(agent.id);

    expect(preview).toEqual({
      agentId: agent.id,
      name: agent.name,
      title: agent.title,
      description: agent.description,
      avatarSeed: agent.avatarSeed,
      avatarHue: agent.avatarHue,
      avatarUrl: null,
      skills: detail.skills,
      routines: detail.routines,
    });
    expect(preview).not.toHaveProperty("model");
    expect(preview).not.toHaveProperty("preview");
    expect(preview.routines[0]).not.toHaveProperty("id");
    expect(preview.routines[0]).not.toHaveProperty("timezone");
  });

  it("creates an independent agent and preserves active routines in the installer timezone", async () => {
    const { marketplace, agents, skills } = service();
    await marketplace.install({ listingId: detail.id, timezone: "America/New_York", receiptId: "receipt-1" });

    expect(agents.createAgentProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        name: detail.name,
        title: detail.title,
        description: detail.description,
      }),
    );
    expect(skills.installVersion).toHaveBeenCalledWith({
      agentId: agent.id,
      skillId: "editing",
      versionId: "editing-v2",
    });
    expect(agents.createRoutine).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: agent.id,
        active: true,
        timezone: "America/New_York",
        schedule: expect.objectContaining({ kind: "interval", anchorAt: expect.not.stringContaining("2026-01-01") }),
      }),
      { recordConversationEvent: false },
    );
  });

  it("removes a partially created agent when a dependency fails", async () => {
    const { marketplace, agents } = service({ failSkill: true });
    await expect(
      marketplace.install({ listingId: detail.id, timezone: "Europe/Warsaw", receiptId: "receipt-2" }),
    ).rejects.toThrow("skill failed");
    expect(agents.deleteAgent).toHaveBeenCalledWith(agent.id);
    expect(agents.createRoutine).not.toHaveBeenCalled();
  });

  it("updates an installed marketplace agent in place", async () => {
    const installed = {
      ...agent,
      marketplaceSource: {
        listingId: detail.id,
        versionId: "market-writer-v1",
        version: 1,
        skillIds: ["retired-skill"],
        routineIds: ["routine-old-id"],
      },
    };
    const { marketplace, agents, skills } = service();
    agents.listAgents.mockReturnValue([installed]);

    const result = await marketplace.install({
      listingId: detail.id,
      agentId: agent.id,
      timezone: "Europe/Warsaw",
      receiptId: "receipt-update",
    });

    expect(agents.createAgentProfile).not.toHaveBeenCalled();
    expect(agents.updateAgent).toHaveBeenCalledWith(expect.objectContaining({ agentId: agent.id, name: detail.name }));
    expect(agents.deleteRoutine).toHaveBeenCalledWith(
      { agentId: agent.id, routineId: "routine-old-id" },
      { recordConversationEvent: false },
    );
    expect(skills.uninstall).toHaveBeenCalledWith({ agentId: agent.id, skillId: "retired-skill" });
    expect(agents.setMarketplaceSource).toHaveBeenCalledWith(
      agent.id,
      expect.objectContaining({ listingId: detail.id, versionId: detail.versionId, version: detail.version }),
    );
    expect(result.agent.id).toBe(agent.id);
  });
});
