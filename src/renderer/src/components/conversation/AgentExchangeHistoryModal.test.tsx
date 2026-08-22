import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { BotMessage, BotProfile } from "../../data";
import { AgentExchangeHistoryModal, directAgentExchangeHistory } from "./AgentExchangeHistoryModal";

const currentBot: BotProfile = {
  id: "chief",
  name: "Chief",
  title: "Chief of staff",
  description: "",
  notifications: true,
  model: "gpt-5.6-luna",
  reasoningEffort: "medium",
  threadId: null,
  avatarSeed: "chief",
  avatarHue: 245,
  avatarUrl: null,
  time: "",
  preview: "",
};

const selectedAgent: BotProfile = {
  ...currentBot,
  id: "research",
  name: "Research",
  title: "Researcher",
  avatarSeed: "research",
  avatarHue: 185,
};

const messages: BotMessage[] = [
  {
    id: "direct-outgoing",
    author: "bot",
    body: "Check the primary sources.",
    time: "10:00 AM",
    kind: "exchange",
    exchange: {
      direction: "outgoing",
      messageId: "outgoing",
      senderBotId: "chief",
      recipientBotIds: ["research"],
      replyToMessageId: null,
      deliveries: [
        {
          id: "delivery-outgoing",
          recipientBotId: "research",
          status: "completed",
          position: null,
          error: null,
        },
      ],
    },
  },
  {
    id: "group-outgoing",
    author: "bot",
    body: "This group send must stay hidden.",
    time: "10:01 AM",
    kind: "exchange",
    exchange: {
      direction: "outgoing",
      messageId: "group",
      senderBotId: "chief",
      recipientBotIds: ["research", "sales"],
      replyToMessageId: null,
      deliveries: [],
    },
  },
  {
    id: "direct-incoming",
    author: "bot",
    body: "The sources are verified.",
    time: "10:02 AM",
    kind: "exchange",
    exchange: {
      direction: "incoming",
      messageId: "incoming",
      senderBotId: "research",
      recipientBotIds: ["chief"],
      replyToMessageId: "outgoing",
      deliveries: [
        {
          id: "delivery-incoming",
          recipientBotId: "chief",
          status: "failed",
          position: null,
          error: "Agent unavailable",
        },
      ],
    },
  },
];

describe("directAgentExchangeHistory", () => {
  it("keeps only one-to-one exchanges between the selected agents", () => {
    expect(directAgentExchangeHistory(messages, "chief", "research").map((message) => message.id)).toEqual([
      "direct-outgoing",
      "direct-incoming",
    ]);
  });
});

describe("AgentExchangeHistoryModal", () => {
  it("does not block the app while closed", () => {
    render(() => (
      <AgentExchangeHistoryModal
        open={false}
        currentBot={currentBot}
        agent={selectedAgent}
        bots={[currentBot, selectedAgent]}
        messages={messages}
        onOpenChange={vi.fn()}
        onSelectAgent={vi.fn()}
        onOpenLink={vi.fn()}
        onPreview={vi.fn()}
        onAttachmentAction={vi.fn()}
      />
    ));

    expect(document.querySelector(".center-morph-modal-backdrop")).not.toBeInTheDocument();
  });

  it("renders direct history and closes without selecting another agent", async () => {
    const [open, setOpen] = createSignal(true);
    const onOpenChange = vi.fn(setOpen);
    const onSelectAgent = vi.fn();
    render(() => (
      <AgentExchangeHistoryModal
        open={open()}
        currentBot={currentBot}
        agent={selectedAgent}
        bots={[currentBot, selectedAgent]}
        messages={messages}
        onOpenChange={onOpenChange}
        onSelectAgent={onSelectAgent}
        onOpenLink={vi.fn()}
        onPreview={vi.fn()}
        onAttachmentAction={vi.fn()}
      />
    ));

    expect(screen.getByRole("dialog", { name: "Messages with Research" })).toBeInTheDocument();
    expect(screen.getByText("Check the primary sources.")).toBeInTheDocument();
    expect(screen.getByText("The sources are verified.")).toBeInTheDocument();
    expect(screen.queryByText("This group send must stay hidden.")).not.toBeInTheDocument();
    expect(screen.getByText("Delivered")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: "Close message history" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSelectAgent).not.toHaveBeenCalled();
    await waitFor(() => expect(document.querySelector(".center-morph-modal-backdrop")).not.toBeInTheDocument());
    await waitFor(() => expect(document.body.style.pointerEvents).not.toBe("none"));
  });
});
