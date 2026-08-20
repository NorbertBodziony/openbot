import { serializeAttachmentReference } from "@openbot/contracts/attachment-references";
import type { AttachmentSummary } from "@openbot/contracts/ipc";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { avatarHeadColor } from "../../bloub-avatar";
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

  it("renders a Markdown table in an agent response without exposing its syntax", () => {
    render(() => (
      <MessageBody
        message={{
          id: "message-table",
          author: "bot",
          body: [
            "Model comparison:",
            "",
            "| Model | Context | $/1M in |",
            "| --- | --- | ---: |",
            "| gpt-4o | 128k | $5.00 |",
            "| claude-3.5 | 200k | $3.00 |",
          ].join("\n"),
          time: "10:00",
        }}
        bots={bots}
        onSelectAgent={vi.fn()}
        onOpenLink={vi.fn()}
        onPreview={vi.fn()}
        onAttachmentAction={vi.fn()}
      />
    ));

    expect(screen.getByText("Model comparison:")).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader")).toHaveLength(3);
    expect(screen.getAllByRole("cell")).toHaveLength(6);
    expect(screen.queryByText("| --- | --- | ---: |")).toBeNull();
  });

  it("keeps Markdown tables in user messages as plain text", () => {
    render(() => (
      <MessageBody
        message={{
          id: "message-user-table",
          author: "you",
          body: "| A | B |\n| --- | --- |\n| 1 | 2 |",
          time: "10:00",
        }}
        bots={bots}
        onSelectAgent={vi.fn()}
        onOpenLink={vi.fn()}
        onPreview={vi.fn()}
        onAttachmentAction={vi.fn()}
      />
    ));

    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText(/\| --- \| --- \|/u)).toBeInTheDocument();
  });

  it("renders a selected-text instruction as a compact quote while preserving reply context", () => {
    render(() => (
      <MessageBody
        message={{
          id: "message-selection-reply",
          author: "you",
          body: "Make this more concise.\n\n> This is the exact selected sentence.",
          replyToMessageId: "message-agent-source",
          time: "10:01",
        }}
        referencedMessage={{
          id: "message-agent-source",
          author: "bot",
          body: "A longer answer containing this exact selected sentence.",
          time: "10:00",
        }}
        bots={bots}
        onSelectAgent={vi.fn()}
        onOpenLink={vi.fn()}
        onPreview={vi.fn()}
        onAttachmentAction={vi.fn()}
      />
    ));

    expect(screen.getByText("Make this more concise.", { selector: ".message-copy" })).toBeInTheDocument();
    expect(screen.getByText("This is the exact selected sentence.", { selector: "blockquote" })).toBeInTheDocument();
    expect(screen.getByText("A longer answer containing this exact selected sentence.")).toBeInTheDocument();
    expect(screen.queryByText(/^> This is/u)).toBeNull();
  });

  it("renders a Markdown feature matrix as a comparison table", () => {
    render(() => (
      <MessageBody
        message={{
          id: "message-comparison-table",
          author: "bot",
          body: [
            "Plan comparison:",
            "",
            "| Feature | Personal | Enterprise |",
            "| --- | --- | --- |",
            "| Unlimited projects | ✓ | ✓ |",
            "| Priority support | — | ✓ |",
          ].join("\n"),
          time: "10:00",
        }}
        bots={bots}
        onSelectAgent={vi.fn()}
        onOpenLink={vi.fn()}
        onPreview={vi.fn()}
        onAttachmentAction={vi.fn()}
      />
    ));

    expect(screen.getByText("Plan comparison:")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Comparison table" })).toBeInTheDocument();
    expect(screen.queryByText("| --- | --- | --- |")).toBeNull();
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

    expect(screen.getByRole("img", { name: "Generating image" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Generating image")).toBeInTheDocument();
    expect(
      document
        .querySelector<HTMLElement>(".image-generation-stage")
        ?.style.getPropertyValue("--image-generation-ratio"),
    ).toBe("4 / 5");
  });

  it("crossfades to a clickable preview when complete", async () => {
    const onPreview = vi.fn();
    const onDownload = vi.fn();
    render(() => (
      <ImageGeneration
        status="completed"
        prompt="A quiet observatory"
        resolution="1024 × 1024"
        aspectRatio="square"
        attachment={attachment}
        onPreview={onPreview}
        onDownload={onDownload}
      />
    ));

    const preview = screen.getByRole("button", { name: "Preview generated image" });
    await fireEvent.click(preview);
    expect(onPreview).toHaveBeenCalledWith(attachment);
    expect(screen.getByAltText("A quiet observatory")).toBeInTheDocument();
    expect(screen.queryByText("Generated image")).toBeNull();
    expect(screen.queryByText("A quiet observatory")).toBeNull();
    expect(screen.getByRole("button", { name: "Download generated image" }).querySelector("svg")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Download generated image" }));
    expect(onDownload).toHaveBeenCalledWith(attachment);
  });

  it("uses the loaded image dimensions for the completed canvas", async () => {
    render(() => (
      <ImageGeneration status="completed" resolution="1024 × 1024" aspectRatio="square" attachment={attachment} />
    ));

    const image = screen.getByAltText("Generated image");
    Object.defineProperties(image, {
      naturalWidth: { configurable: true, value: 1536 },
      naturalHeight: { configurable: true, value: 1024 },
    });
    await fireEvent.load(image);

    expect(
      document
        .querySelector<HTMLElement>(".image-generation-stage")
        ?.style.getPropertyValue("--image-generation-ratio"),
    ).toBe("1536 / 1024");
  });

  it("shows the failure mark when the preview cannot load", async () => {
    render(() => (
      <ImageGeneration
        status="completed"
        prompt="A quiet observatory"
        resolution="1024 × 1024"
        aspectRatio="square"
        attachment={attachment}
      />
    ));

    await fireEvent.error(screen.getByAltText("A quiet observatory"));
    expect(screen.getByRole("alert")).toHaveTextContent("preview is unavailable");
    expect(screen.getByRole("img", { name: "Image unavailable" })).toBeInTheDocument();
    expect(screen.getByText("×")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it.each([
    ["failed", "Image generation failed"],
    ["interrupted", "Image generation interrupted"],
  ] as const)("shows a failure mark for %s without retry", (status, label) => {
    render(() => (
      <ImageGeneration
        status={status}
        prompt="A quiet observatory"
        resolution="1024 × 1024"
        aspectRatio="landscape"
        error="Provider timeout"
      />
    ));

    expect(screen.getByRole("alert")).toHaveTextContent("Provider timeout");
    expect(screen.getByRole("img", { name: label })).toBeInTheDocument();
    expect(screen.getByText("×")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });
});
