import type {
  BotSummary,
  InstalledSkill,
  MarketplaceAgentDetail,
  MarketplaceSkillPage,
  OpenBotDesktopApi,
  SkillSubmission,
} from "@openbot/contracts/ipc";
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkillsMarketplaceModal } from "./SkillsMarketplaceModal";

const nativeCanvasGetContext = HTMLCanvasElement.prototype.getContext;

describe("SkillsMarketplaceModal", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      writable: true,
      value: nativeCanvasGetContext,
    });
  });

  beforeEach(() => {
    const page: MarketplaceSkillPage = {
      skills: [
        {
          id: "release-notes",
          slug: "release-notes",
          name: "Release Notes",
          description: "Turns merged work into clear release notes.",
          category: "documents",
          creatorName: "Ada",
          version: 2,
          installs: 1280,
          featured: true,
          iconUrl: null,
          updatedAt: "2026-08-25T00:00:00.000Z",
        },
      ],
      nextCursor: null,
    };
    const skills: OpenBotDesktopApi["skills"] = {
      list: vi.fn(async (query) => (query?.category === "documents" ? page : { skills: [], nextCursor: null })),
      get: vi.fn(async () => {
        const skill = page.skills[0];
        if (!skill) throw new Error("Missing test skill.");
        return {
          ...skill,
          versionId: "release-notes-v2",
          bundleSha256: "abc123",
          files: ["SKILL.md", "references/template.md"],
          instructions: "Group changes by customer impact and call out breaking changes.",
        };
      }),
      listMine: vi.fn(async () => []),
      choosePackage: vi.fn(),
      submit: vi.fn(),
      listInstalled: vi.fn(async () => []),
      install: vi.fn(),
      uninstall: vi.fn(),
    };
    window.openbot = { ...window.openbot, skills };
    window.openbot.marketplaceAgents = {
      list: vi.fn(async () => ({ agents: [], nextCursor: null })),
      get: vi.fn(),
      listMine: vi.fn(async () => []),
      preview: vi.fn(),
      submit: vi.fn(),
      install: vi.fn(),
    };
  });

  it("opens the approved skill instructions inside the marketplace modal", async () => {
    render(() => (
      <SkillsMarketplaceModal
        open
        bots={[{ id: "writer", name: "Writer" }]}
        activeBotId="writer"
        onOpenChange={() => undefined}
      />
    ));
    const listing = await screen.findByRole("button", { name: "View Release Notes details" });
    const marketplaceBody = document.querySelector<HTMLElement>(".skills-marketplace-body");
    if (!marketplaceBody) throw new Error("Missing marketplace body.");
    marketplaceBody.scrollTop = 320;
    listing.click();
    expect(marketplaceBody.scrollTop).toBe(0);
    const details = await screen.findByRole("region", { name: "Release Notes details" });
    expect(marketplaceBody).toHaveAttribute("data-detail-open");
    expect(within(details).getByText("What this skill does")).toBeInTheDocument();
    expect(within(details).getByText(/Group changes by customer impact/u)).toBeInTheDocument();
    expect(within(details).getByText("references/template.md")).toBeInTheDocument();
    within(details).getByRole("button", { name: "Back to skills" }).click();
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Release Notes details" })).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(marketplaceBody.scrollTop).toBe(320));
    expect(marketplaceBody).not.toHaveAttribute("data-detail-open");
  });

  it("shows discover listings and install totals", async () => {
    render(() => (
      <SkillsMarketplaceModal
        open
        bots={[{ id: "writer", name: "Writer" }]}
        activeBotId="writer"
        onOpenChange={() => undefined}
      />
    ));
    expect(screen.getByRole("dialog", { name: "Marketplace" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skills" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Agents" })).toBeEnabled();
    await waitFor(() => expect(screen.getByText("Release Notes")).toBeInTheDocument());
    expect(screen.getByText(/1,280 installs/u)).toBeInTheDocument();
    expect(screen.getByLabelText("Search skills")).toBeInTheDocument();
    expect(window.openbot.skills.list).toHaveBeenCalledWith({
      category: "documents",
      sort: "installs",
      limit: 5,
    });
  });

  it("confirms active routines before installing an independent agent", async () => {
    const detail: MarketplaceAgentDetail = {
      id: "research-agent",
      versionId: "research-agent-v1",
      name: "Research Agent",
      title: "Finds evidence quickly",
      description: "Searches sources and produces concise cited findings.",
      creatorName: "Ada",
      version: 1,
      installs: 42,
      featured: true,
      avatarSeed: "research-agent",
      avatarHue: 215,
      avatarUrl: "https://example.com/research-agent.png",
      skillCount: 1,
      routineCount: 1,
      activeRoutineCount: 1,
      updatedAt: "2026-08-25T00:00:00.000Z",
      skills: [{ skillId: "research", versionId: "research-v1", slug: "research", name: "Research", version: 1 }],
      routines: [
        {
          name: "Daily brief",
          instruction: "Prepare a brief.",
          active: true,
          schedule: { kind: "daily", time: "09:00" },
        },
      ],
    };
    const installedBot = {
      id: "bot-installed",
      name: detail.name,
      title: detail.title,
      description: detail.description,
      notifications: true,
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
      threadId: null,
      workspacePath: "/tmp/bot-installed",
      preview: "No messages yet",
      updatedAt: null,
      avatarSeed: detail.avatarSeed,
      avatarHue: detail.avatarHue,
      avatarUrl: detail.avatarUrl,
    } satisfies BotSummary;
    window.openbot.marketplaceAgents.list = vi.fn(async () => ({ agents: [detail], nextCursor: null }));
    window.openbot.marketplaceAgents.get = vi.fn(async () => detail);
    window.openbot.marketplaceAgents.install = vi.fn(async () => ({ bot: installedBot }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const onInstalled = vi.fn();

    render(() => (
      <SkillsMarketplaceModal
        open
        bots={[]}
        activeBotId=""
        onOpenChange={() => undefined}
        onAgentInstalled={onInstalled}
      />
    ));
    screen.getByRole("button", { name: "Agents" }).click();
    (await screen.findByRole("button", { name: "View Research Agent" })).click();
    (await screen.findByRole("button", { name: "Install agent" })).click();

    await waitFor(() => expect(window.openbot.marketplaceAgents.install).toHaveBeenCalled());
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("1 active routine"));
    expect(window.openbot.marketplaceAgents.install).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: detail.id }),
    );
    await waitFor(() => expect(onInstalled).toHaveBeenCalledWith(installedBot));
  });

  it("offers updates and disables agents that are already current", async () => {
    const baseAgent = {
      name: "Research Agent",
      title: "Finds evidence quickly",
      description: "Searches sources and produces concise cited findings.",
      creatorName: "Ada",
      installs: 42,
      featured: true,
      avatarSeed: "research-agent",
      avatarHue: 215,
      avatarUrl: null,
      skillCount: 1,
      routineCount: 0,
      activeRoutineCount: 0,
      updatedAt: "2026-08-25T00:00:00.000Z",
    } as const;
    window.openbot.marketplaceAgents.list = vi.fn(async () => ({
      agents: [
        { ...baseAgent, id: "research-agent", version: 2 },
        { ...baseAgent, id: "writer-agent", name: "Writer Agent", version: 1 },
      ],
      nextCursor: null,
    }));

    render(() => (
      <SkillsMarketplaceModal
        open
        bots={[
          {
            id: "research-local",
            name: "Research Agent",
            marketplaceSource: {
              agentId: "research-agent",
              versionId: "research-v1",
              version: 1,
              skillIds: [],
              routineIds: [],
            },
          },
          {
            id: "writer-local",
            name: "Writer Agent",
            marketplaceSource: {
              agentId: "writer-agent",
              versionId: "writer-v1",
              version: 1,
              skillIds: [],
              routineIds: [],
            },
          },
        ]}
        activeBotId="research-local"
        onOpenChange={() => undefined}
      />
    ));

    screen.getByRole("button", { name: "Agents" }).click();
    expect(await screen.findByRole("button", { name: "Update" })).toBeEnabled();
    expect(
      screen.getAllByRole("button", { name: "Installed" }).find((button) => button.hasAttribute("disabled")),
    ).toBeDefined();
  });

  it("keeps the shared marketplace navigation when browsing installed agents", async () => {
    render(() => (
      <SkillsMarketplaceModal
        open
        bots={[{ id: "writer", name: "Writer" }]}
        activeBotId="writer"
        onOpenChange={() => undefined}
      />
    ));

    screen.getByRole("button", { name: "Agents" }).click();
    screen.getByRole("button", { name: "Installed" }).click();

    expect(await screen.findByRole("heading", { name: "Local agents" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Writer" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add agent" })).toBeInTheDocument();
  });

  it("waits 500ms after typing before searching", async () => {
    vi.useFakeTimers();
    render(() => <SkillsMarketplaceModal open bots={[]} activeBotId="" onOpenChange={() => undefined} />);
    await Promise.resolve();
    await Promise.resolve();
    const list = vi.mocked(window.openbot.skills.list);
    list.mockClear();

    fireEvent.input(screen.getByLabelText("Search skills"), { target: { value: "solana" } });
    await vi.advanceTimersByTimeAsync(499);
    expect(list).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(list).toHaveBeenCalled();
  });

  it("shows the default skill icon when a marketplace image fails to load", async () => {
    const pageWithIcon: MarketplaceSkillPage = {
      skills: [
        {
          id: "release-notes",
          slug: "release-notes",
          name: "Release Notes",
          description: "Turns merged work into clear release notes.",
          category: "documents",
          creatorName: "Ada",
          version: 2,
          installs: 1280,
          featured: true,
          iconUrl: "http://127.0.0.1:3100/v1/skills/release-notes/icon?v=release-notes-v2",
          updatedAt: "2026-08-25T00:00:00.000Z",
        },
      ],
      nextCursor: null,
    };
    window.openbot.skills.list = vi.fn(async () => pageWithIcon);
    render(() => <SkillsMarketplaceModal open bots={[]} activeBotId="" onOpenChange={() => undefined} />);

    await waitFor(() => expect(document.querySelector(".skills-marketplace-icon img")).toBeInTheDocument());
    const icon = document.querySelector<HTMLImageElement>(".skills-marketplace-icon img");
    if (!icon) throw new Error("Missing marketplace skill image.");
    fireEvent.error(icon);

    await waitFor(() => expect(document.querySelector(".skills-marketplace-icon svg")).toBeInTheDocument());
  });

  it("uses category and card skeletons while discover listings load", async () => {
    let resolvePage!: (page: MarketplaceSkillPage) => void;
    const pendingPage = new Promise<MarketplaceSkillPage>((resolve) => {
      resolvePage = resolve;
    });
    window.openbot.skills.list = vi.fn(() => pendingPage);

    render(() => (
      <SkillsMarketplaceModal
        open
        bots={[{ id: "writer", name: "Writer" }]}
        activeBotId="writer"
        onOpenChange={() => undefined}
      />
    ));

    expect(screen.getByRole("status", { name: "Loading skills" })).toBeInTheDocument();
    expect(document.querySelectorAll(".skills-marketplace-category-section")).toHaveLength(8);
    expect(document.querySelectorAll(".skills-marketplace-card-skeleton")).toHaveLength(40);

    resolvePage({ skills: [], nextCursor: null });
    await waitFor(() => expect(screen.queryByRole("status", { name: "Loading skills" })).not.toBeInTheDocument());
  });

  it("uses the final detail layout while a skill loads", async () => {
    const loadedDetail = await window.openbot.skills.get("release-notes");
    let resolveDetail!: (detail: typeof loadedDetail) => void;
    window.openbot.skills.get = vi.fn(
      () =>
        new Promise<typeof loadedDetail>((resolve) => {
          resolveDetail = resolve;
        }),
    );

    render(() => (
      <SkillsMarketplaceModal
        open
        bots={[{ id: "writer", name: "Writer" }]}
        activeBotId="writer"
        onOpenChange={() => undefined}
      />
    ));
    const listing = await screen.findByRole("button", { name: "View Release Notes details" });
    listing.click();

    expect(await screen.findByRole("status", { name: "Loading skill" })).toBeInTheDocument();
    expect(document.querySelector(".skills-marketplace-detail-hero")).toBeInTheDocument();
    expect(document.querySelector(".skills-marketplace-detail-content")).toBeInTheDocument();

    resolveDetail(loadedDetail);
    await screen.findByRole("region", { name: "Release Notes details" });
  });

  it("opens details from an installed skill row", async () => {
    const installed: InstalledSkill[] = [
      {
        skillId: "release-notes",
        slug: "release-notes",
        name: "Release Notes",
        installedVersion: 2,
        availableVersion: 2,
        state: "installed",
      },
    ];
    window.openbot.skills.listInstalled = vi.fn(async () => installed);
    render(() => (
      <SkillsMarketplaceModal
        open
        bots={[{ id: "writer", name: "Writer" }]}
        activeBotId="writer"
        onOpenChange={() => undefined}
      />
    ));

    screen.getByRole("button", { name: "Installed" }).click();
    const listing = await screen.findByRole("button", { name: "View Release Notes details" });
    listing.click();

    expect(await screen.findByRole("region", { name: "Release Notes details" })).toBeInTheDocument();
  });

  it("opens pending submission details from its row", async () => {
    const submissions: SkillSubmission[] = [
      {
        id: "release-notes-v3",
        skillId: "release-notes",
        slug: "release-notes",
        name: "Release Notes",
        description: "Turns merged work into clear release notes.",
        category: "documents",
        version: 3,
        status: "pending",
        rejectionNote: null,
        iconUrl: null,
        createdAt: "2026-08-25T00:00:00.000Z",
      },
    ];
    window.openbot.skills.listMine = vi.fn(async () => submissions);
    render(() => <SkillsMarketplaceModal open bots={[]} activeBotId="" onOpenChange={() => undefined} />);

    screen.getByRole("button", { name: "My submissions" }).click();
    const listing = await screen.findByRole("button", { name: "View Release Notes submission details" });
    listing.click();

    const details = await screen.findByRole("region", { name: "Release Notes submission details" });
    expect(within(details).getByRole("heading", { name: "Review status" })).toBeInTheDocument();
    expect(within(details).getByText("pending")).toBeInTheDocument();
  });

  it("moves to the creator view", async () => {
    render(() => <SkillsMarketplaceModal open bots={[]} activeBotId="" onOpenChange={() => undefined} />);
    screen.getByRole("button", { name: "My submissions" }).click();
    await waitFor(() => expect(screen.getByText(/No submissions yet/u)).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "Submission requirements" })).toBeInTheDocument();
    expect(screen.getByText("SKILL.md")).toBeInTheDocument();
    expect(screen.getByText(/5 skills total/u)).toBeInTheDocument();
    expect(screen.getByText(/5 submitted versions per skill/u)).toBeInTheDocument();
  });

  it("keeps the selected icon filename visible and previews it", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 512, height: 512, close: vi.fn() })),
    );
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      writable: true,
      value: vi.fn(() => ({
        drawImage: vi.fn(),
        imageSmoothingEnabled: false,
        imageSmoothingQuality: "low",
      })),
    });
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
      callback(new Blob([new Uint8Array([1])], { type: "image/webp" }));
    });
    window.openbot.skills.choosePackage = vi.fn(async () => ({
      draftId: "release-notes-draft",
      name: "Release Notes",
      description: "Turns merged work into clear release notes.",
      slug: "release-notes",
      files: ["SKILL.md"],
      size: 1024,
    }));
    render(() => <SkillsMarketplaceModal open bots={[]} activeBotId="" onOpenChange={() => undefined} />);

    screen.getByRole("button", { name: "My submissions" }).click();
    (await screen.findByRole("button", { name: "Choose folder or ZIP" })).click();
    const input = await screen.findByLabelText("Icon (optional)");
    const icon = new File(["icon"], "skill-icon.png", { type: "image/png" });
    Object.defineProperty(input, "value", {
      configurable: true,
      writable: true,
      value: "C:\\fakepath\\skill-icon.png",
    });

    fireEvent.change(input, { target: { files: [icon] } });

    await waitFor(() => expect(document.querySelector(".skills-publish-summary img")).toBeInTheDocument());
    expect(document.querySelector(".skills-publish-summary img")).toHaveAttribute(
      "src",
      expect.stringMatching(/^data:image\/webp;base64,/u),
    );
    expect(input).toHaveValue("C:\\fakepath\\skill-icon.png");
  });

  it("explains how to resolve a duplicate skill name", async () => {
    window.openbot.skills.choosePackage = vi.fn(async () => ({
      draftId: "release-notes-draft",
      name: "Release Notes",
      description: "Turns merged work into clear release notes.",
      slug: "release-notes",
      files: ["SKILL.md"],
      size: 1024,
    }));
    window.openbot.skills.submit = vi.fn(async () => {
      throw new Error("Error invoking remote method 'skills:submit': Error: A skill with this name already exists.");
    });
    render(() => <SkillsMarketplaceModal open bots={[]} activeBotId="" onOpenChange={() => undefined} />);

    screen.getByRole("button", { name: "My submissions" }).click();
    (await screen.findByRole("button", { name: "Choose folder or ZIP" })).click();
    (await screen.findByRole("button", { name: "Submit for review" })).click();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That skill name is already taken. Choose a different name in SKILL.md, then try again.",
    );
  });
});
