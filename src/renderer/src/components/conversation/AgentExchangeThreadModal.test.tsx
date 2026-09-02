import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { BotMessage, BotProfile } from "../../data";
import { AgentExchangeThreadModal, exchangeThreadMessages } from "./AgentExchangeThreadModal";

const bots = [bot("chief", "Chief"), bot("research", "Research"), bot("sales", "Sales")];

describe("exchangeThreadMessages", () => {
  it("returns the clicked reply tree in conversation order, including group branches", () => {
    const messages = [
      exchange("unrelated", "sales", ["chief"], null, "Unrelated"),
      exchange("root", "chief", ["research", "sales"], null, "Investigate"),
      exchange("research-reply", "research", ["chief"], "root", "Research result"),
      exchange("sales-reply", "sales", ["chief"], "root", "Sales result"),
      exchange("follow-up", "chief", ["research"], "research-reply", "One more question"),
    ];

    expect(exchangeThreadMessages(messages, "research-reply").map((message) => message.exchange?.messageId)).toEqual([
      "root",
      "research-reply",
      "sales-reply",
      "follow-up",
    ]);
  });

  it("stops safely at missing parents and reply cycles", () => {
    const orphan = exchange("orphan", "research", ["chief"], "missing", "Orphan");
    const child = exchange("child", "chief", ["research"], "orphan", "Child");
    const cycleA = exchange("cycle-a", "chief", ["sales"], "cycle-b", "A");
    const cycleB = exchange("cycle-b", "sales", ["chief"], "cycle-a", "B");

    expect(exchangeThreadMessages([orphan, child, cycleA, cycleB], "orphan")).toEqual([orphan, child]);
    expect(exchangeThreadMessages([orphan, child, cycleA, cycleB], "cycle-a")).toEqual([cycleA, cycleB]);
    expect(exchangeThreadMessages([orphan], "not-loaded")).toEqual([]);
  });
});

describe("AgentExchangeThreadModal", () => {
  it("shows the reply-linked messages and keeps agent references interactive", async () => {
    const onSelectAgent = vi.fn();
    const messages = [
      exchange("root", "chief", ["research"], null, "Ask @[Research](agent:research) to investigate."),
      exchange("reply", "research", ["chief"], "root", "The evidence is ready."),
      exchange("unrelated", "sales", ["chief"], null, "Do not show this."),
    ];
    const [open, setOpen] = createSignal(false);
    render(() => (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Open thread
        </button>
        <AgentExchangeThreadModal
          open={open()}
          messageId="reply"
          selectedAgent={bots[1]}
          currentBot={bots[0]}
          bots={bots}
          messages={messages}
          onOpenChange={setOpen}
          onSelectAgent={onSelectAgent}
          onOpenLink={vi.fn()}
          onPreview={vi.fn()}
          onAttachmentAction={vi.fn()}
        />
      </>
    ));

    const trigger = screen.getByRole("button", { name: "Open thread" });
    trigger.focus();
    await fireEvent.click(trigger);
    expect(await screen.findByRole("dialog", { name: "Agent message thread" })).toBeInTheDocument();
    expect(screen.getByText("The evidence is ready.")).toBeInTheDocument();
    expect(screen.queryByText("Do not show this.")).not.toBeInTheDocument();

    await fireEvent.click(screen.getAllByRole("button", { name: "Open agent Research" })[0]);
    expect(onSelectAgent).toHaveBeenCalledWith("research");

    await fireEvent.click(screen.getByRole("button", { name: "Close message thread" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Agent message thread" })).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});

function exchange(
  messageId: string,
  senderBotId: string,
  recipientBotIds: string[],
  replyToMessageId: string | null,
  body: string,
): BotMessage {
  return {
    id: `row-${messageId}`,
    author: "bot",
    body,
    time: "10:00 AM",
    createdAt: "2026-09-01T08:00:00.000Z",
    kind: "exchange",
    exchange: {
      direction: senderBotId === "chief" ? "outgoing" : "incoming",
      messageId,
      senderBotId,
      recipientBotIds,
      replyToMessageId,
      deliveries: recipientBotIds.map((recipientBotId) => ({
        id: `${messageId}-${recipientBotId}`,
        recipientBotId,
        status: "completed",
        position: null,
        error: null,
      })),
    },
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
