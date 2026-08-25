import type { MarketplaceSkillPage, OpenBotDesktopApi } from "@openbot/contracts/ipc";
import { render, screen, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SkillsMarketplaceModal } from "./SkillsMarketplaceModal";

describe("SkillsMarketplaceModal", () => {
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
      get: vi.fn(),
      listMine: vi.fn(async () => []),
      choosePackage: vi.fn(),
      submit: vi.fn(),
      listInstalled: vi.fn(async () => []),
      install: vi.fn(),
      uninstall: vi.fn(),
    };
    window.openbot = { ...window.openbot, skills };
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
    expect(screen.getByRole("button", { name: "Agents" })).toBeDisabled();
    await waitFor(() => expect(screen.getByText("Release Notes")).toBeInTheDocument());
    expect(screen.getByText(/1,280 installs/u)).toBeInTheDocument();
    expect(screen.getByLabelText("Search skills")).toBeInTheDocument();
    expect(window.openbot.skills.list).toHaveBeenCalledWith({
      category: "documents",
      sort: "installs",
      limit: 5,
    });
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
});
