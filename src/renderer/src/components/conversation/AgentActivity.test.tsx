import { render, screen } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import type { BotProfile } from "../../data";
import { AgentActivityIndicator } from "./AgentActivity";

const bot: BotProfile = {
  id: "chief",
  name: "Chief",
  role: "Coordinator",
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
  it("does not show an avatar while working", () => {
    const view = render(() => <AgentActivityIndicator bot={bot} state="Working" />);

    expect(screen.getByRole("status", { name: "Chief is working" })).toBeInTheDocument();
    expect(view.container.querySelector(".agent-activity-avatar")).toBeNull();
  });

  it("keeps the avatar for queued work", () => {
    const view = render(() => <AgentActivityIndicator bot={bot} state="Queued" />);

    expect(view.container.querySelector(".agent-activity-avatar")).toBeInTheDocument();
  });

  it("renders no activity bubble when idle", () => {
    const view = render(() => <AgentActivityIndicator bot={bot} state={null} />);

    expect(view.container.querySelector(".agent-activity-entry")).toBeNull();
  });
});
