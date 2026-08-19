import { serializeAttachmentReference } from "@openbot/contracts/attachment-references";
import type { AttachmentSummary } from "@openbot/contracts/ipc";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { avatarHeadColor } from "../../blobatar";
import type { BotMessage, BotProfile } from "../../data";
import { ImageGeneration } from "./ImageGeneration";
import { ExchangeSystemRow, MessageBody } from "./MessageRendering";

const bots: BotProfile[] = [
  {
    id: "research",
    name: "Research",
    role: "Researcher",
    description: "",
    notifications: true,
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    threadId: null,
    avatarSeed: "research",
    avatarHue: 245,
    avatarUrl: null,
    time: "",
    preview: "",
  },
  {
    id: "sales",
    name: "Sales",
    role: "Sales",
    description: "",
    notifications: true,
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    threadId: null,
    avatarSeed: "sales",
    avatarHue: 185,
    avatarUrl: null,
    time: "",
    preview: "",
  },
];

const message: BotMessage = {
  id: "exchange-1",
  author: "bot",
  body: "",
  time: "10:00",
  kind: "exchange",
  exchange: {
    direction: "outgoing",
    messageId: "message-1",
    senderBotId: "chief",
    recipientBotIds: bots.map((bot) => bot.id),
    replyToMessageId: null,
    deliveries: [],
  },
};

describe("ExchangeSystemRow", () => {
  it("mixes every recipient avatar color for a multi-agent trigger", () => {
    render(() => <ExchangeSystemRow message={message} bots={bots} onSelectAgent={vi.fn()} />);

    const trigger = screen.getByRole("button", { name: "2 agents, show list" });
    const researchColor = avatarHeadColor(bots[0].avatarSeed, bots[0].avatarHue);
    const salesColor = avatarHeadColor(bots[1].avatarSeed, bots[1].avatarHue);
    expect(trigger.style.getPropertyValue("--exchange-agent-color")).toBe(
      `color-mix(in oklab, ${researchColor} 50%, ${salesColor})`,
    );
  });
});

describe("MessageBody", () => {
  it("renders referenced files inline without duplicating their attachment cards", async () => {
    const attachments: AttachmentSummary[] = [
      {
        id: "attachment-types",
        name: "start-types.d.ts",
        size: 1_024,
        kind: "file",
        mimeType: "text/plain",
        previewKind: "text",
        previewUrl: null,
      },
      {
        id: "attachment-agents",
        name: "AGENTS.md",
        size: 2_048,
        kind: "file",
        mimeType: "text/plain",
        previewKind: "text",
        previewUrl: null,
      },
    ];
    const onPreview = vi.fn();
    render(() => (
      <MessageBody
        message={{
          id: "message-files",
          author: "you",
          body: `Review ${serializeAttachmentReference("start-types.d.ts", "attachment-types")}`,
          time: "10:00",
          attachments,
        }}
        bots={bots}
        onSelectAgent={vi.fn()}
        onOpenLink={vi.fn()}
        onPreview={onPreview}
        onAttachmentAction={vi.fn()}
      />
    ));

    const reference = screen.getByRole("button", {
      name: "Open attached file start-types.d.ts",
    });
    expect(screen.queryByRole("button", { name: "Preview start-types.d.ts" })).toBeNull();
    expect(screen.getByRole("button", { name: "Preview AGENTS.md" })).toBeInTheDocument();
    await fireEvent.click(reference);
    expect(onPreview).toHaveBeenCalledWith(attachments[0]);
  });
});

describe("ImageGeneration", () => {
  const attachment: AttachmentSummary = {
    id: "generated-image",
    name: "generated-image.png",
    size: 12,
    kind: "image",
    mimeType: "image/png",
    previewKind: "image",
    previewUrl: "openbot-attachment://file/generated-image",
  };

  it("exposes the generating state and preserves the requested aspect ratio", () => {
    render(() => (
      <ImageGeneration
        status="generating"
        prompt="A quiet observatory"
        resolution="1024 × 1280"
        aspectRatio="portrait"
      />
    ));

    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Generating image")).toBeInTheDocument();
    expect(
      document
        .querySelector<HTMLElement>(".image-generation-stage")
        ?.style.getPropertyValue("--image-generation-ratio"),
    ).toBe("4 / 5");
  });

  it("crossfades to a clickable preview when complete", async () => {
    const onPreview = vi.fn();
    render(() => (
      <ImageGeneration
        status="completed"
        prompt="A quiet observatory"
        resolution="1024 × 1024"
        aspectRatio="square"
        attachment={attachment}
        onPreview={onPreview}
      />
    ));

    const preview = screen.getByRole("button", { name: "Preview generated image" });
    await fireEvent.click(preview);
    expect(onPreview).toHaveBeenCalledWith(attachment);
    expect(screen.getByAltText("A quiet observatory")).toBeInTheDocument();
  });

  it("keeps the canvas for errors and offers an accessible retry", async () => {
    const onRetry = vi.fn();
    render(() => (
      <ImageGeneration
        status="failed"
        prompt="A quiet observatory"
        resolution="1024 × 1024"
        aspectRatio="landscape"
        error="Provider timeout"
        onRetry={onRetry}
      />
    ));

    expect(screen.getByRole("alert")).toHaveTextContent("Provider timeout");
    await fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
