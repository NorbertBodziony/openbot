import { render, screen } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import type { BotProfile } from "../../data";
import { AgentActivityIndicator, type AgentActivityPresentation, nextAgentActivityPresentation } from "./AgentActivity";

const bot: BotProfile = {
  id: "chief",
  name: "Chief",
  title: "Coordinator",
  description: "",
  notifications: true,
  model: "gpt-5.6-luna",
  reasoningEffort: "medium",
  threadId: "thread-chief",
  avatarSeed: "chief",
  avatarHue: 185,
  avatarUrl: null,
  time: "",
  preview: "",
};

describe("AgentActivityIndicator", () => {
  it("shows the selected animated Bloub and stable label while working", () => {
    const presentation: AgentActivityPresentation = { animation: "orbit", label: "Working on it…" };
    const view = render(() => (
      <AgentActivityIndicator bot={{ ...bot, avatarUrl: "mock-avatar://chief" }} presentation={presentation} />
    ));

    expect(screen.getByRole("status", { name: "Chief is working" })).toBeInTheDocument();
    expect(screen.getByText("Working on it…")).toBeInTheDocument();
    expect(view.container.querySelector('[data-animation-state="orbit"].agent-activity-avatar > svg')).not.toBeNull();
    expect(view.container.querySelector(".agent-activity-avatar img")).toBeNull();
    expect(view.container.querySelector(".agent-activity-bubble")).toBeNull();
  });

  it("does not repeat the previous animation or label", () => {
    const previous: AgentActivityPresentation = { animation: "thinking", label: "Working on it…" };
    const next = nextAgentActivityPresentation(previous, () => 0);

    expect(next.animation).not.toBe(previous.animation);
    expect(next.label).not.toBe(previous.label);
  });
});
