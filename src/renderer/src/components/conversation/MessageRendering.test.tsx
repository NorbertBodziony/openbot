import { serializeAttachmentReference } from "@openbot/contracts/attachment-references";
import type { AttachmentSummary } from "@openbot/contracts/ipc";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { BotProfile } from "../../data";
import { triggerResize } from "../../setupTests";
import { ImageGeneration } from "./ImageGeneration";
import { MarkdownMessageText } from "./MarkdownMessageText";
import { MessageBody } from "./MessageRendering";

const bots: BotProfile[] = [
  {
    id: "research",
    provider: "codex",
    name: "Research",
    title: "Researcher",
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
    provider: "codex",
    name: "Sales",
    title: "Sales",
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

  it("renders a plain attachment name inline without duplicating its card", async () => {
    const attachment: AttachmentSummary = {
      id: "attachment-report",
      name: "raport.csv",
      size: 1_024,
      kind: "file",
      mimeType: "text/csv",
      previewKind: "text",
      previewUrl: null,
    };
    const onPreview = vi.fn();
    render(() => (
      <MessageBody
        message={{
          id: "message-plain-file",
          author: "bot",
          body: "Here is **raport.csv**.",
          time: "10:00",
          attachments: [attachment],
        }}
        bots={bots}
        onSelectAgent={vi.fn()}
        onOpenLink={vi.fn()}
        onPreview={onPreview}
        onAttachmentAction={vi.fn()}
      />
    ));

    const reference = screen.getByRole("button", { name: "Open attached file raport.csv" });
    expect(screen.queryByRole("button", { name: "Preview raport.csv" })).toBeNull();
    await fireEvent.click(reference);
    expect(onPreview).toHaveBeenCalledWith(attachment);
  });

  it("renders an image attached by an agent as a large preview", async () => {
    const attachment: AttachmentSummary = {
      id: "agent-screenshot",
      name: "desktop-screenshot.png",
      size: 1_966_000,
      kind: "image",
      mimeType: "image/png",
      previewKind: "image",
      previewUrl: "openbot-attachment://file/agent-screenshot",
    };
    const onPreview = vi.fn();
    const onDownload = vi.fn();
    render(() => (
      <MessageBody
        message={{
          id: "message-agent-screenshot",
          author: "bot",
          body: "",
          time: "10:00",
          status: "completed",
          itemType: "agent_attachment",
          attachments: [attachment],
        }}
        bots={bots}
        onSelectAgent={vi.fn()}
        onOpenLink={vi.fn()}
        onPreview={onPreview}
        onAttachmentAction={vi.fn()}
        onDownload={onDownload}
      />
    ));

    const image = screen.getByAltText("desktop-screenshot.png");
    await fireEvent.load(image);
    expect(screen.getByLabelText("Attached image")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Preview desktop-screenshot.png" })).toBeInTheDocument();
    expect(screen.queryByText("1.9 MB")).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "Preview desktop-screenshot.png" }));
    expect(onPreview).toHaveBeenCalledWith(attachment);
    await fireEvent.click(screen.getByRole("button", { name: "Download desktop-screenshot.png" }));
    expect(onDownload).toHaveBeenCalledWith(attachment);
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
            "| **Model** | Context | $/1M in |",
            "| --- | --- | ---: |",
            "| **gpt-4o** | 128k | $5.00 |",
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
    expect(screen.getByText("Model").tagName).toBe("STRONG");
    expect(screen.getByText("gpt-4o").tagName).toBe("STRONG");
    expect(screen.queryByText("| --- | --- | ---: |")).toBeNull();
  });

  it("renders common Markdown in an agent response as semantic chat content", () => {
    const onOpenLink = vi.fn();
    const { container } = render(() => (
      <MessageBody
        message={{
          id: "message-markdown",
          author: "bot",
          body: [
            "## Recommendation",
            "",
            "Use **Kobalte** with *Solid UI* and ~~remove the fallback~~.",
            "Read the source [1].",
            "",
            "- Accessible controls",
            "  - Keyboard support",
            "- [x] Tested",
            "",
            "1. Install `@kobalte/core`.",
            "2. Read [the guide](https://kobalte.dev/docs/core/overview/introduction).",
            "",
            "> Keep the public API small.",
            "",
            "---",
            "",
            "<script>alert('unsafe')</script>",
          ].join("\n"),
          time: "10:00",
          citations: [
            {
              number: 1,
              label: "Kobalte introduction",
              url: "https://kobalte.dev/docs/core/overview/introduction",
              host: "kobalte.dev",
            },
          ],
        }}
        bots={bots}
        onSelectAgent={vi.fn()}
        onOpenLink={onOpenLink}
        onPreview={vi.fn()}
        onAttachmentAction={vi.fn()}
      />
    ));

    expect(screen.getByRole("heading", { level: 2, name: "Recommendation" })).toBeInTheDocument();
    expect(screen.getByText("Kobalte").tagName).toBe("STRONG");
    expect(screen.getByText("Solid UI").tagName).toBe("EM");
    expect(screen.getByText("remove the fallback").tagName).toBe("DEL");
    expect(screen.getByText("@kobalte/core").tagName).toBe("CODE");
    expect(screen.getAllByRole("list")).toHaveLength(3);
    expect(screen.getByRole("checkbox", { name: "Tested" })).toBeChecked();
    expect(screen.getByRole("link", { name: "Open citation 1: Kobalte introduction" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open source 1: Kobalte introduction" })).toBeInTheDocument();
    expect(screen.getByText("Keep the public API small.").closest("blockquote")).toBeInTheDocument();
    expect(container.querySelector("hr")).toBeInTheDocument();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText("<script>alert('unsafe')</script>")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "the guide" }));
    expect(onOpenLink).toHaveBeenCalledWith("https://kobalte.dev/docs/core/overview/introduction");
  });

  it("renders absolute agent workspace Markdown paths as file controls", async () => {
    const onOpenWorkspaceFile = vi.fn();
    const pagePath = "/Users/arozycka23/OpenBot/Bots/bot-7b62fdf2/app/page.tsx";
    const cssPath = "/Users/arozycka23/OpenBot/Bots/bot-7b62fdf2/app/globals.css";
    render(() => (
      <MessageBody
        message={{
          id: "message-workspace-paths",
          author: "bot",
          body: `Pliki:\n\n- [page.tsx](${pagePath})\n- [globals.css](${cssPath})`,
          time: "10:00",
        }}
        bots={bots}
        onSelectAgent={vi.fn()}
        onOpenLink={vi.fn()}
        onPreview={vi.fn()}
        onAttachmentAction={vi.fn()}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
      />
    ));

    const pageLink = screen.getByRole("button", { name: "Open workspace file page.tsx" });
    const cssLink = screen.getByRole("button", { name: "Open workspace file globals.css" });
    expect(pageLink).toHaveTextContent("page.tsx");
    expect(cssLink).toHaveTextContent("globals.css");
    expect(screen.queryByText(pagePath)).toBeNull();
    expect(screen.queryByText(cssPath)).toBeNull();
    await fireEvent.click(pageLink);
    await fireEvent.click(cssLink);
    expect(onOpenWorkspaceFile).toHaveBeenNthCalledWith(1, pagePath);
    expect(onOpenWorkspaceFile).toHaveBeenNthCalledWith(2, cssPath);
  });

  it("routes absolute Shared Markdown paths through the shared file handler", async () => {
    const onOpenSharedFile = vi.fn();
    const onOpenWorkspaceFile = vi.fn();
    const sharedPath = "/Users/arozycka23/OpenBot/Shared/shared-access-test.txt";
    render(() => (
      <MessageBody
        message={{
          id: "message-shared-path",
          author: "bot",
          body: `Shared result: [shared-access-test.txt](${sharedPath})`,
          time: "10:00",
        }}
        bots={bots}
        onSelectAgent={vi.fn()}
        onOpenLink={vi.fn()}
        onPreview={vi.fn()}
        onAttachmentAction={vi.fn()}
        onOpenSharedFile={onOpenSharedFile}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
      />
    ));

    const fileLink = screen.getByRole("button", { name: "Open shared file shared-access-test.txt" });
    await fireEvent.click(fileLink);
    expect(onOpenSharedFile).toHaveBeenCalledWith(sharedPath);
    expect(onOpenWorkspaceFile).not.toHaveBeenCalled();
  });

  it("repairs escaped Markdown delimiters around Windows file links", async () => {
    const onOpenSharedFile = vi.fn();
    const onOpenWorkspaceFile = vi.fn();
    const forwardSlashPath = "C:/Users/julia/OpenBot/Shared/Outputs/FineRite-Krakow-social-links-final.xlsx";
    const backslashPath = String.raw`C:\Users\julia\OpenBot\Shared\Outputs\FineRite-Krakow-social-links-backslash.xlsx`;
    render(() => (
      <MessageBody
        message={{
          id: "message-windows-shared-paths",
          author: "bot",
          body: [
            String.raw`[**Pobierz aktualny plik Excel**]\(<${forwardSlashPath}>)`,
            String.raw`[Pobierz drugi plik]\(<${backslashPath}>\)`,
          ].join("\n\n"),
          time: "10:00",
        }}
        bots={bots}
        onSelectAgent={vi.fn()}
        onOpenLink={vi.fn()}
        onPreview={vi.fn()}
        onAttachmentAction={vi.fn()}
        onOpenSharedFile={onOpenSharedFile}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
      />
    ));

    const forwardSlashLink = screen.getByRole("button", {
      name: "Open shared file FineRite-Krakow-social-links-final.xlsx",
    });
    const backslashLink = screen.getByRole("button", {
      name: "Open shared file FineRite-Krakow-social-links-backslash.xlsx",
    });
    expect(forwardSlashLink).toHaveTextContent("Pobierz aktualny plik Excel");
    expect(backslashLink).toHaveTextContent("Pobierz drugi plik");
    expect(forwardSlashLink).not.toHaveTextContent("**");
    expect(forwardSlashLink).not.toHaveTextContent(forwardSlashPath);
    expect(backslashLink).not.toHaveTextContent(backslashPath);
    expect(forwardSlashLink).not.toHaveTextContent(/[[\]\\()]/u);
    expect(backslashLink).not.toHaveTextContent(/[[\]\\()]/u);

    await fireEvent.click(forwardSlashLink);
    await fireEvent.click(backslashLink);
    expect(onOpenSharedFile).toHaveBeenNthCalledWith(1, forwardSlashPath);
    expect(onOpenSharedFile).toHaveBeenNthCalledWith(2, backslashPath);
    expect(onOpenWorkspaceFile).not.toHaveBeenCalled();
  });

  it("repairs an escaped local file link with inline code in its label", async () => {
    const onOpenWorkspaceFile = vi.fn();
    const path = String.raw`C:\tmp\report.xlsx`;
    render(() => (
      <MarkdownMessageText
        body={`[Open \`report.xlsx\`]\\(<${path}>\\)`}
        bots={bots}
        onSelectAgent={vi.fn()}
        onOpenLink={vi.fn()}
        onOpenSharedFile={vi.fn()}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
      />
    ));

    const fileLink = screen.getByRole("button", { name: "Open workspace file report.xlsx" });
    expect(fileLink).toHaveTextContent("Open report.xlsx");
    await fireEvent.click(fileLink);
    expect(onOpenWorkspaceFile).toHaveBeenCalledWith(path);
  });

  it("does not repair escaped Markdown delimiters around web links or images", () => {
    const onOpenSharedFile = vi.fn();
    const onOpenWorkspaceFile = vi.fn();
    const imagePath = String.raw`C:\tmp\preview.png`;
    const { container } = render(() => (
      <MessageBody
        message={{
          id: "message-escaped-web-link",
          author: "bot",
          body: [
            String.raw`[OpenAI]\(<https://example.com/OpenBot/Shared/docs.xlsx>\)`,
            String.raw`[Report]\(<//example.com/OpenBot/Shared/report.xlsx>\)`,
            String.raw`![Preview]\(<${imagePath}>\)`,
          ].join("\n"),
          time: "10:00",
        }}
        bots={bots}
        onSelectAgent={vi.fn()}
        onOpenLink={vi.fn()}
        onPreview={vi.fn()}
        onAttachmentAction={vi.fn()}
        onOpenSharedFile={onOpenSharedFile}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
      />
    ));

    expect(screen.queryByRole("button", { name: /Open (?:shared|workspace) file/u })).toBeNull();
    expect(container).toHaveTextContent("[OpenAI](");
    expect(container).toHaveTextContent("https://example.com/OpenBot/Shared/docs.xlsx");
    expect(container).toHaveTextContent("[Report](");
    expect(container).toHaveTextContent("//example.com/OpenBot/Shared/report.xlsx");
    expect(container).toHaveTextContent("![Preview](");
    expect(container).toHaveTextContent(imagePath);
    expect(container.querySelector(".message-markdown-image")).toBeNull();
    expect(onOpenSharedFile).not.toHaveBeenCalled();
    expect(onOpenWorkspaceFile).not.toHaveBeenCalled();
  });

  it("keeps code and HTML literal while repairing a later file link", async () => {
    const inlineCode = String.raw`[inline]\(<C:\tmp\inline.txt>\)`;
    const fencedCode = String.raw`[fenced]\(<C:\tmp\fenced.txt>\)`;
    const html = String.raw`<code>[html]\(<C:\tmp\html.txt>\)</code>`;
    const nestedCode = String.raw`[nested]\(<C:\tmp\nested.txt>\)`;
    const reportPath = String.raw`C:\tmp\report.xlsx`;
    const commentReportPath = String.raw`C:\tmp\comment-report.xlsx`;
    const onOpenWorkspaceFile = vi.fn();
    const { container } = render(() => (
      <MarkdownMessageText
        body={[
          `Inline: \`${inlineCode}\``,
          "",
          "```md",
          fencedCode,
          "```",
          "",
          `${html} then ${String.raw`[report]\(<${reportPath}>\)`}`,
          "",
          `Before <!-- <div> --> then ${String.raw`[comment report]\(<${commentReportPath}>\)`}`,
          "",
          `>     ${nestedCode}`,
        ].join("\n")}
        bots={bots}
        onSelectAgent={vi.fn()}
        onOpenLink={vi.fn()}
        onOpenSharedFile={vi.fn()}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
      />
    ));

    expect(container).toHaveTextContent(inlineCode);
    expect(container).toHaveTextContent(fencedCode);
    expect(container).toHaveTextContent(String.raw`<code>[html](<C:\tmp\html.txt>)</code>`);
    expect(container).toHaveTextContent(nestedCode);
    const reportLink = screen.getByRole("button", { name: "Open workspace file report.xlsx" });
    const commentReportLink = screen.getByRole("button", { name: "Open workspace file comment-report.xlsx" });
    expect(container.querySelectorAll(".message-file-reference")).toHaveLength(2);
    await fireEvent.click(reportLink);
    await fireEvent.click(commentReportLink);
    expect(onOpenWorkspaceFile).toHaveBeenNthCalledWith(1, reportPath);
    expect(onOpenWorkspaceFile).toHaveBeenNthCalledWith(2, commentReportPath);
  });

  it("turns filenames listed after a Shared directory into preview references", async () => {
    const onOpenSharedFile = vi.fn();
    const onOpenWorkspaceFile = vi.fn();
    const directory = "/Users/sniezka/OpenBot/Shared/";
    const names = [
      "recipe-format-sample.txt",
      "recipe-format-sample.md",
      "recipe-format-sample.csv",
      "recipe-format-sample.json",
    ];
    render(() => (
      <MessageBody
        message={{
          id: "message-shared-file-list",
          author: "bot",
          body: `Created four formats in \`${directory}\`:\n\n${names.map((name) => `- \`${name}\``).join("\n")}`,
          time: "10:00",
        }}
        bots={bots}
        onSelectAgent={vi.fn()}
        onOpenLink={vi.fn()}
        onPreview={vi.fn()}
        onAttachmentAction={vi.fn()}
        onOpenSharedFile={onOpenSharedFile}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
      />
    ));

    for (const name of names) {
      await fireEvent.click(screen.getByRole("button", { name: `Open shared file ${name}` }));
    }
    expect(onOpenSharedFile.mock.calls).toEqual(names.map((name) => [`${directory}${name}`]));
    expect(onOpenWorkspaceFile).not.toHaveBeenCalled();
    expect(screen.getByText(directory).tagName).toBe("CODE");
  });

  it("turns standalone file-like code mentions into workspace preview references", async () => {
    const onOpenWorkspaceFile = vi.fn();
    render(() => (
      <MessageBody
        message={{
          id: "message-relative-file-list",
          author: "bot",
          body: "Updated `package.json` and `src/main.ts`.",
          time: "10:00",
        }}
        bots={bots}
        onSelectAgent={vi.fn()}
        onOpenLink={vi.fn()}
        onPreview={vi.fn()}
        onAttachmentAction={vi.fn()}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
      />
    ));

    await fireEvent.click(screen.getByRole("button", { name: "Open workspace file package.json" }));
    await fireEvent.click(screen.getByRole("button", { name: "Open workspace file main.ts" }));
    expect(onOpenWorkspaceFile).toHaveBeenNthCalledWith(1, "package.json");
    expect(onOpenWorkspaceFile).toHaveBeenNthCalledWith(2, "src/main.ts");
  });

  it("normalizes an angle-wrapped relative workspace link with spaces", async () => {
    const onOpenWorkspaceFile = vi.fn();
    render(() => (
      <MessageBody
        message={{
          id: "message-relative-workspace-path",
          author: "bot",
          body: "Gotowe: [otwórz tablicę Lutra w HTML](< lutra-brand-board.html >)",
          time: "10:00",
        }}
        bots={bots}
        onSelectAgent={vi.fn()}
        onOpenLink={vi.fn()}
        onPreview={vi.fn()}
        onAttachmentAction={vi.fn()}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
      />
    ));

    const fileLink = screen.getByRole("button", { name: "Open workspace file lutra-brand-board.html" });
    expect(fileLink).toHaveTextContent("otwórz tablicę Lutra w HTML");
    expect(screen.queryByText(/lutra-brand-board\.html/u)).toBeNull();
    expect(screen.queryByText(/\(<|>\)/u)).toBeNull();
    await fireEvent.click(fileLink);
    expect(onOpenWorkspaceFile).toHaveBeenCalledWith("lutra-brand-board.html");
  });

  it("reveals streaming Markdown updates gradually in the same message", async () => {
    const [body, setBody] = createSignal("## Plan\n\nUse **Kobal");
    const [streaming, setStreaming] = createSignal(true);
    const { container } = render(() => (
      <MessageBody
        message={{
          id: "message-streaming-markdown",
          author: "bot",
          body: body(),
          time: "10:00",
          streaming: streaming(),
        }}
        bots={bots}
        onSelectAgent={vi.fn()}
        onOpenLink={vi.fn()}
        onPreview={vi.fn()}
        onAttachmentAction={vi.fn()}
      />
    ));

    expect(screen.getByRole("heading", { level: 2, name: "Plan" })).toBeInTheDocument();
    expect(screen.getByText("Use Kobal")).toBeInTheDocument();
    const messageContent = container.querySelector<HTMLElement>(".message-content-blocks");
    const messageResize = container.querySelector<HTMLElement>(".message-content-resize");
    if (!messageContent || !messageResize) throw new Error("Streaming resize elements are missing.");
    expect(messageContent).not.toHaveTextContent("**");
    let contentHeight = 40;
    vi.spyOn(messageContent, "getBoundingClientRect").mockImplementation(() =>
      DOMRect.fromRect({ height: contentHeight, width: 640, x: 0, y: 0 }),
    );
    const animate = vi.fn().mockReturnValue({ cancel: vi.fn(), finished: Promise.resolve() });
    Object.defineProperty(messageResize, "animate", { configurable: true, value: animate });
    triggerResize(messageContent);

    setBody("## Plan\n\nUse **Kobalte**.\n\n- Parse Markdown\n- Resize the row");
    setStreaming(false);
    contentHeight = 80;
    triggerResize(messageContent);

    expect(animate).toHaveBeenCalledWith([{ height: "40px" }, { height: "80px" }], {
      duration: 240,
      easing: "cubic-bezier(0.23, 1, 0.32, 1)",
    });

    expect(screen.queryByText("Kobalte")).toBeNull();
    expect(messageContent).not.toHaveTextContent("Resize the row");
    await waitFor(() => expect(screen.getByText("Kobalte").tagName).toBe("STRONG"));
    expect(messageContent).not.toHaveTextContent("Resize the row");
    await waitFor(() => expect(messageContent).toHaveTextContent("Resize the row"));
    expect(screen.getByText("Parse Markdown")).toBeInTheDocument();
    expect(screen.queryByText("Use Kobal")).toBeNull();
    expect(container.querySelector(".message-content-blocks")).toBe(messageContent);
  });

  it("hides a punctuation-adjacent strong marker while streaming", async () => {
    const [body, setBody] = createSignal("Use (**Kobal");
    const [streaming, setStreaming] = createSignal(true);
    const { container } = render(() => (
      <MessageBody
        message={{
          id: "message-streaming-punctuation",
          author: "bot",
          body: body(),
          time: "10:00",
          streaming: streaming(),
        }}
        bots={bots}
        onSelectAgent={vi.fn()}
        onOpenLink={vi.fn()}
        onPreview={vi.fn()}
        onAttachmentAction={vi.fn()}
      />
    ));

    expect(screen.getByText("Use (Kobal")).toBeInTheDocument();
    expect(container).not.toHaveTextContent("**");

    setBody("Use (**Kobalte**).");
    setStreaming(false);

    await waitFor(() => expect(screen.getByText("Kobalte").tagName).toBe("STRONG"));
    expect(container).toHaveTextContent("Use (Kobalte).");
    expect(container).not.toHaveTextContent("**");
  });

  it("hides a valid underscore strong marker but preserves an intraword delimiter", async () => {
    const [body, setBody] = createSignal("Use __Kobal, but keep a__literal");
    const [streaming, setStreaming] = createSignal(true);
    const { container } = render(() => (
      <MessageBody
        message={{
          id: "message-streaming-underscore",
          author: "bot",
          body: body(),
          time: "10:00",
          streaming: streaming(),
        }}
        bots={bots}
        onSelectAgent={vi.fn()}
        onOpenLink={vi.fn()}
        onPreview={vi.fn()}
        onAttachmentAction={vi.fn()}
      />
    ));

    expect(container).toHaveTextContent("Use Kobal, but keep a__literal");
    expect(container).not.toHaveTextContent("Use __Kobal");

    setBody("Use __Kobalte__, but keep a__literal");
    setStreaming(false);

    await waitFor(() => expect(screen.getByText("Kobalte").tagName).toBe("STRONG"));
    expect(container).toHaveTextContent("Use Kobalte, but keep a__literal");
  });

  it.each([
    ["*", "asterisk italic", "em"],
    ["_", "underscore italic", "em"],
    ["***", "asterisk bold italic", "em strong, strong em"],
    ["___", "underscore bold italic", "em strong, strong em"],
    ["****", "nested asterisk bold", "strong strong"],
    ["____", "nested underscore bold", "strong strong"],
  ])("hides an incomplete %s marker while streaming", async (marker, name, selector) => {
    const [body, setBody] = createSignal(`Use ${marker}Kobal`);
    const [streaming, setStreaming] = createSignal(true);
    const { container } = render(() => (
      <MessageBody
        message={{
          id: `message-streaming-combined-${name}`,
          author: "bot",
          body: body(),
          time: "10:00",
          streaming: streaming(),
        }}
        bots={bots}
        onSelectAgent={vi.fn()}
        onOpenLink={vi.fn()}
        onPreview={vi.fn()}
        onAttachmentAction={vi.fn()}
      />
    ));

    expect(container).toHaveTextContent("Use Kobal");
    expect(container).not.toHaveTextContent(marker);

    setBody(`Use ${marker}Kobalte${marker}`);
    setStreaming(false);

    await waitFor(() => expect(container.querySelector(selector)).toHaveTextContent("Kobalte"));
    expect(container).not.toHaveTextContent(marker);
  });

  it("hides every incomplete nested emphasis opener while streaming", async () => {
    const [body, setBody] = createSignal("Use **bold [link](https://example.com) and _italic");
    const [streaming, setStreaming] = createSignal(true);
    const { container } = render(() => (
      <MessageBody
        message={{
          id: "message-streaming-nested-emphasis",
          author: "bot",
          body: body(),
          time: "10:00",
          streaming: streaming(),
        }}
        bots={bots}
        onSelectAgent={vi.fn()}
        onOpenLink={vi.fn()}
        onPreview={vi.fn()}
        onAttachmentAction={vi.fn()}
      />
    ));

    expect(container).toHaveTextContent("Use bold link and italic");
    expect(container).not.toHaveTextContent("**");
    expect(container).not.toHaveTextContent("_italic");
    expect(screen.getByRole("link", { name: "link" })).toBeInTheDocument();

    setBody("Use **bold [link](https://example.com) and _italic_**");
    setStreaming(false);

    await waitFor(() => expect(container.querySelector("strong em")).toHaveTextContent("italic"));
    expect(container.querySelector("strong a")).toHaveTextContent("link");
  });

  it("cleans an opener before a completed inline token without changing its contents", () => {
    const { container } = render(() => (
      <MessageBody
        message={{
          id: "message-streaming-link",
          author: "bot",
          body: "Use **[Kobal](https://example.com), keep [label **literal](https://example.com/label)",
          time: "10:00",
          streaming: true,
        }}
        bots={bots}
        onSelectAgent={vi.fn()}
        onOpenLink={vi.fn()}
        onPreview={vi.fn()}
        onAttachmentAction={vi.fn()}
      />
    ));

    expect(container).toHaveTextContent("Use Kobal, keep label **literal");
    expect(container).not.toHaveTextContent("Use **");
    expect(screen.getByRole("link", { name: "Kobal" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "label **literal" })).toBeInTheDocument();
  });

  it.each(["Use *", "Use _", "Use **", "Use __", "Use ***", "Use ___", "Use ****", "Use ____"])(
    "hides an emphasis marker at the end of a streaming chunk",
    (body) => {
      const { container } = render(() => (
        <MessageBody
          message={{
            id: `message-streaming-marker-${body.at(-1)}`,
            author: "bot",
            body,
            time: "10:00",
            streaming: true,
          }}
          bots={bots}
          onSelectAgent={vi.fn()}
          onOpenLink={vi.fn()}
          onPreview={vi.fn()}
          onAttachmentAction={vi.fn()}
        />
      ));

      expect(container).toHaveTextContent("Use");
      expect(container).not.toHaveTextContent(body.trim().slice(4));
    },
  );

  it.each(["value*", "value_", "value**", "value__", "value***", "value___"])(
    "preserves a literal trailing delimiter while streaming",
    (body) => {
      const { container } = render(() => (
        <MessageBody
          message={{
            id: `message-streaming-literal-${body.at(-1)}`,
            author: "bot",
            body,
            time: "10:00",
            streaming: true,
          }}
          bots={bots}
          onSelectAgent={vi.fn()}
          onOpenLink={vi.fn()}
          onPreview={vi.fn()}
          onAttachmentAction={vi.fn()}
        />
      ));

      expect(container).toHaveTextContent(body);
    },
  );

  it.each([
    ["closed paragraph", "Earlier **literal\n\n"],
    ["closed heading", "# Heading **literal\n"],
  ])("preserves markers in a %s while another block can stream", (name, body) => {
    const { container } = render(() => (
      <MessageBody
        message={{
          id: `message-streaming-${name.replaceAll(" ", "-")}`,
          author: "bot",
          body,
          time: "10:00",
          streaming: true,
        }}
        bots={bots}
        onSelectAgent={vi.fn()}
        onOpenLink={vi.fn()}
        onPreview={vi.fn()}
        onAttachmentAction={vi.fn()}
      />
    ));

    expect(container).toHaveTextContent("**literal");
  });

  it("keeps earlier text unchanged while a structured block streams", () => {
    render(() => (
      <MessageBody
        message={{
          id: "message-streaming-code",
          author: "bot",
          body: "Earlier **literal\n\n```js\nconst answer = 4",
          time: "10:00",
          streaming: true,
        }}
        bots={bots}
        onSelectAgent={vi.fn()}
        onOpenLink={vi.fn()}
        onPreview={vi.fn()}
        onAttachmentAction={vi.fn()}
      />
    ));

    expect(screen.getByText("Earlier **literal")).toBeInTheDocument();
    expect(screen.getByText("const answer = 4")).toBeInTheDocument();
  });

  it("hides an incomplete marker in the final cell of a nested streaming table", async () => {
    const [body, setBody] = createSignal("> | A | B |\n> | --- | --- |\n> | x | **bold");
    const [streaming, setStreaming] = createSignal(true);
    const { container } = render(() => (
      <MessageBody
        message={{
          id: "message-streaming-nested-table",
          author: "bot",
          body: body(),
          time: "10:00",
          streaming: streaming(),
        }}
        bots={bots}
        onSelectAgent={vi.fn()}
        onOpenLink={vi.fn()}
        onPreview={vi.fn()}
        onAttachmentAction={vi.fn()}
      />
    ));

    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(container).toHaveTextContent("bold");
    expect(container).not.toHaveTextContent("**");

    setBody("> | A | B |\n> | --- | --- |\n> | x | **bold**");
    setStreaming(false);

    await waitFor(() => expect(screen.getByText("bold").tagName).toBe("STRONG"));
  });

  it("hides an incomplete marker in an unpadded source cell", async () => {
    const [body, setBody] = createSignal("> | A | B |\n> | --- | --- |\n> | **bold");
    const [streaming, setStreaming] = createSignal(true);
    const { container } = render(() => (
      <MessageBody
        message={{
          id: "message-streaming-short-table-row",
          author: "bot",
          body: body(),
          time: "10:00",
          streaming: streaming(),
        }}
        bots={bots}
        onSelectAgent={vi.fn()}
        onOpenLink={vi.fn()}
        onPreview={vi.fn()}
        onAttachmentAction={vi.fn()}
      />
    ));

    expect(container).toHaveTextContent("bold");
    expect(container).not.toHaveTextContent("**");

    setBody("> | A | B |\n> | --- | --- |\n> | **bold**");
    setStreaming(false);

    await waitFor(() => expect(screen.getByText("bold").tagName).toBe("STRONG"));
  });

  it.each([
    ["closing pipe", "> | A | B |\n> | --- | --- |\n> | x | **literal |"],
    ["newline", "> | A | B |\n> | --- | --- |\n> | x | **literal\n"],
  ])("preserves markers in a table cell closed by a %s", (_boundary, body) => {
    const { container } = render(() => (
      <MessageBody
        message={{
          id: "message-streaming-closed-table-cell",
          author: "bot",
          body,
          time: "10:00",
          streaming: true,
        }}
        bots={bots}
        onSelectAgent={vi.fn()}
        onOpenLink={vi.fn()}
        onPreview={vi.fn()}
        onAttachmentAction={vi.fn()}
      />
    ));

    expect(container).toHaveTextContent("**literal");
  });

  it.each([
    ["list", "- | A | B |\n  | --- | --- |\n  | x | **literal\n"],
    ["list in a blockquote", "> - | A | B |\n>   | --- | --- |\n>   | x | **literal\n"],
  ])("preserves markers in a closed table nested through a %s", (_containerName, body) => {
    const { container } = render(() => (
      <MessageBody
        message={{
          id: "message-streaming-closed-nested-table",
          author: "bot",
          body,
          time: "10:00",
          streaming: true,
        }}
        bots={bots}
        onSelectAgent={vi.fn()}
        onOpenLink={vi.fn()}
        onPreview={vi.fn()}
        onAttachmentAction={vi.fn()}
      />
    ));

    expect(container).toHaveTextContent("**literal");
  });

  it("preserves literal markers in a completed streaming table header", () => {
    const { container } = render(() => (
      <MessageBody
        message={{
          id: "message-streaming-table-header",
          author: "bot",
          body: "| A | **literal |\n| --- | --- |",
          time: "10:00",
          streaming: true,
        }}
        bots={bots}
        onSelectAgent={vi.fn()}
        onOpenLink={vi.fn()}
        onPreview={vi.fn()}
        onAttachmentAction={vi.fn()}
      />
    ));

    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(container).toHaveTextContent("**literal");
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

  it("keeps the full routine instruction in its message body", () => {
    render(() => (
      <MessageBody
        message={{
          id: "message-routine",
          author: "you",
          body: "Prepare the full morning brief with every required section.",
          time: "07:00",
          routine: {
            routineId: "routine-1",
            runId: "run-1",
            name: "Morning brief",
            scheduledFor: "2026-08-25T05:00:00.000Z",
          },
          status: "Queued #1",
        }}
        bots={bots}
        onSelectAgent={vi.fn()}
        onOpenLink={vi.fn()}
        onPreview={vi.fn()}
        onAttachmentAction={vi.fn()}
      />
    ));

    expect(screen.getByText("Prepare the full morning brief with every required section.")).toBeInTheDocument();
    expect(screen.getByText("Queued #1")).toBeInTheDocument();
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
            "| **Unlimited projects** | ✓ | ✓ |",
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
    expect(screen.getByText("Unlimited projects").tagName).toBe("STRONG");
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

  it("exposes the generating state", () => {
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

  it("shows the failure mark when the preview cannot load", async () => {
    const onDownload = vi.fn();
    render(() => (
      <ImageGeneration
        status="completed"
        presentation="attachment"
        prompt="A quiet observatory"
        resolution="1024 × 1024"
        aspectRatio="square"
        attachment={attachment}
        onDownload={onDownload}
      />
    ));

    await fireEvent.error(screen.getByAltText("A quiet observatory"));
    expect(screen.getByRole("alert")).toHaveTextContent("preview is unavailable");
    expect(screen.getByRole("img", { name: "Image unavailable" })).toBeInTheDocument();
    expect(screen.getByText("×")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "Download generated-image.png" }));
    expect(onDownload).toHaveBeenCalledWith(attachment);
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
