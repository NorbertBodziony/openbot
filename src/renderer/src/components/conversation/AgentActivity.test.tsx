import { render, screen } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import type { BotProfile } from "../../data";
import { AgentActivityIndicator } from "./AgentActivity";

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
  it("shows only an animated Bloub while working", () => {
    const view = render(() => (
      <AgentActivityIndicator bot={{ ...bot, avatarUrl: "mock-avatar://chief" }} state="Working" />
    ));

    expect(screen.getByRole("status", { name: "Chief is working" })).toBeInTheDocument();
    expect(
      view.container.querySelector(".agent-activity-avatar.bot-avatar-motion-always.bot-avatar-bloub > svg"),
    ).not.toBeNull();
    expect(view.container.querySelector(".agent-activity-avatar img")).toBeNull();
    expect(view.container.querySelector(".agent-activity-bubble")).toBeNull();
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
