import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import type { BotProfile, ChatActionMarkerModel } from "../../data";
import { ChatActionMarker } from "./ChatActionMarker";

const bots: BotProfile[] = [bot("research", "Research"), bot("sales", "Sales")];

describe("ChatActionMarker", () => {
  it("opens a single outgoing agent target and shows its aggregate state", async () => {
    const onSelectAgent = vi.fn();
    render(() => (
      <ChatActionMarker
        marker={agentMarker([{ agentId: "research", status: "running" }], "in-progress")}
        bots={bots}
        onSelectAgent={onSelectAgent}
      />
    ));

    expect(screen.getByRole("group", { name: "Messaged Research, In progress" })).toBeInTheDocument();
    expect(screen.queryByText("In progress")).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Open chat with Research" }));
    expect(onSelectAgent).toHaveBeenCalledWith("research");
  });

  it("distinguishes a received agent message from a sent message", () => {
    render(() => (
      <ChatActionMarker
        marker={{
          ...agentMarker([{ agentId: "chief", status: "completed" }], "completed"),
          direction: "incoming",
          sourceAgentId: "research",
        }}
        bots={bots}
        onSelectAgent={vi.fn()}
      />
    ));

    expect(screen.getByText("Message from")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Message from Research, Completed" })).toBeInTheDocument();
    expect(screen.queryByText("Completed")).not.toBeInTheDocument();
  });

  it("lists each target state for a multi-agent message", async () => {
    render(() => (
      <ChatActionMarker
        marker={agentMarker(
          [
            { agentId: "research", status: "completed" },
            { agentId: "sales", status: "failed" },
          ],
          "partial",
        )}
        bots={bots}
        onSelectAgent={vi.fn()}
      />
    ));

    await fireEvent.pointerDown(screen.getByRole("button", { name: /2 agents/u }), {
      pointerType: "mouse",
      button: 0,
    });
    expect(await screen.findByText("Completed")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });

  it("renders missing agents and unavailable routines without an action", () => {
    const { unmount } = render(() => (
      <ChatActionMarker
        marker={agentMarker([{ agentId: "missing", status: "failed" }], "failed")}
        bots={bots}
        onSelectAgent={vi.fn()}
      />
    ));
    expect(screen.getByText("Unavailable agent")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /missing|Unavailable agent/u })).not.toBeInTheDocument();
    unmount();

    render(() => (
      <ChatActionMarker
        marker={routineMarker("cancelled")}
        bots={bots}
        routineAvailable={false}
        onSelectAgent={vi.fn()}
        onOpenRoutine={vi.fn()}
      />
    ));
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open routine Morning brief" })).not.toBeInTheDocument();
  });

  it("opens an available routine and does not announce restored history", async () => {
    const onOpenRoutine = vi.fn();
    render(() => (
      <ChatActionMarker
        marker={routineMarker("needs-attention")}
        bots={bots}
        onSelectAgent={vi.fn()}
        onOpenRoutine={onOpenRoutine}
      />
    ));

    const marker = screen.getByRole("group", { name: "Routine needs attention, Morning brief" });
    expect(marker).toHaveAttribute("aria-live", "off");
    await fireEvent.click(screen.getByRole("button", { name: "Open routine Morning brief" }));
    expect(onOpenRoutine).toHaveBeenCalledWith({ routineId: "routine-1", name: "Morning brief" });
  });

  it("opens a published site and keeps terminal failures noninteractive", async () => {
    const onOpenHostedSite = vi.fn();
    const { unmount } = render(() => (
      <ChatActionMarker
        marker={siteMarker("publish", "succeeded")}
        bots={bots}
        onSelectAgent={vi.fn()}
        onOpenHostedSite={onOpenHostedSite}
      />
    ));

    const restored = screen.getByRole("group", {
      name: "Published site, launch-page-23456789ab.openbot.site",
    });
    expect(restored).toHaveAttribute("aria-live", "off");
    await fireEvent.click(screen.getByRole("button", { name: "Open site launch-page-23456789ab.openbot.site" }));
    expect(onOpenHostedSite).toHaveBeenCalledWith("https://launch-page-23456789ab.openbot.site");
    unmount();

    render(() => (
      <ChatActionMarker
        marker={siteMarker("replace", "failed")}
        bots={bots}
        announce
        onSelectAgent={vi.fn()}
        onOpenHostedSite={onOpenHostedSite}
      />
    ));
    const live = screen.getByRole("status", { name: "Site update failed, launch-page-23456789ab.openbot.site" });
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(screen.queryByRole("button", { name: /Open site/u })).not.toBeInTheDocument();
  });
});

function agentMarker(
  targetDeliveries: Extract<ChatActionMarkerModel, { kind: "agent-message" }>["targetDeliveries"],
  status: Extract<ChatActionMarkerModel, { kind: "agent-message" }>["status"],
): Extract<ChatActionMarkerModel, { kind: "agent-message" }> {
  return {
    kind: "agent-message",
    direction: "outgoing",
    sourceAgentId: "chief",
    targetDeliveries,
    status,
    timestamp: "2026-09-01T08:00:00.000Z",
    messageId: "message-1",
    replyToMessageId: null,
  };
}

function routineMarker(
  status: Extract<ChatActionMarkerModel, { kind: "routine-run" }>["status"],
): Extract<ChatActionMarkerModel, { kind: "routine-run" }> {
  return {
    kind: "routine-run",
    sourceAgentId: "chief",
    routineId: "routine-1",
    runId: "run-1",
    routineName: "Morning brief",
    status,
    timestamp: "2026-09-01T08:00:00.000Z",
  };
}

function siteMarker(
  action: Extract<ChatActionMarkerModel, { kind: "hosted-site" }>["action"],
  status: Extract<ChatActionMarkerModel, { kind: "hosted-site" }>["status"],
): Extract<ChatActionMarkerModel, { kind: "hosted-site" }> {
  return {
    kind: "hosted-site",
    sourceAgentId: "chief",
    action,
    status,
    operationId: "operation-1",
    siteId: "site-1",
    title: "Launch page",
    hostname: "launch-page-23456789ab.openbot.site",
    url: "https://launch-page-23456789ab.openbot.site",
    timestamp: "2026-09-01T08:00:00.000Z",
  };
}

function bot(id: string, name: string): BotProfile {
  return {
    id,
    name,
    title: name,
    description: "",
    notifications: true,
    provider: "codex",
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    threadId: null,
    avatarSeed: id,
    avatarHue: null,
    avatarUrl: null,
    time: "",
    preview: "",
  };
}
