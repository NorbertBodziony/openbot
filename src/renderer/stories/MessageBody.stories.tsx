import { expect, fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { MessageBody } from "../src/components/conversation/MessageRendering";
import { Bubble, BubbleContent, type BubbleVariant } from "../src/components/ui";
import type { AgentMessage } from "../src/data";
import { STORY_AGENTS, STORY_ATTACHMENTS } from "./fixtures";

const message: AgentMessage = {
  id: "message-body-1",
  author: "agent",
  body: "Here is the latest brief. You can also review https://openbot.run/docs or ask @Research.",
  time: "10:00",
  status: "Ready to review",
  attachments: STORY_ATTACHMENTS,
};

const args: Parameters<typeof MessageBody>[0] = {
  message,
  referencedMessage: undefined,
  agents: STORY_AGENTS,
  onSelectAgent: fn(),
  onOpenLink: fn(),
  onPreview: fn(),
  onAttachmentAction: fn(),
};

const meta = {
  title: "Conversation/MessageBody",
  component: MessageBody,
  args,
  parameters: { layout: "centered" },
} satisfies Meta<typeof MessageBody>;

export default meta;
type Story = StoryObj<typeof meta>;

function MessageBodySurface(props: {
  args: Parameters<typeof MessageBody>[0];
  author?: "assistant" | "user";
  variant?: BubbleVariant;
  width: string;
}) {
  const author = () => props.author ?? "assistant";
  return (
    <Bubble
      align={author() === "user" ? "end" : "start"}
      variant={props.variant ?? (author() === "user" ? "default" : "muted")}
      data-author={author()}
      style={{ width: props.width, "max-width": "calc(100vw - 32px)" }}
    >
      <BubbleContent>
        <MessageBody {...props.args} />
      </BubbleContent>
    </Bubble>
  );
}

export const RichMessage: Story = {};

export const WithReplyContext: Story = {
  args: {
    referencedMessage: {
      id: "message-reference",
      author: "you",
      body: "Can you make this more concise?",
      time: "09:55",
    },
  },
};

export const WithSelectedTextInstruction: Story = {
  args: {
    message: {
      ...message,
      id: "message-selected-text-instruction",
      author: "you",
      body: "Make this more concise.\n\n> The selected sentence keeps all of the original context.",
      replyToMessageId: "message-reference",
      status: undefined,
      attachments: [],
    },
    referencedMessage: {
      id: "message-reference",
      author: "agent",
      body: "A longer agent response containing the selected sentence and supporting context.",
      time: "09:55",
    },
  },
  render: (storyArgs) => <MessageBodySurface args={storyArgs} author="user" width="360px" />,
};

export const AttachmentOnly: Story = {
  args: {
    message: { ...message, body: "", status: undefined },
  },
};

export const Markdown: Story = {
  args: {
    message: {
      ...message,
      id: "message-markdown",
      body: [
        "## Recommendation",
        "",
        "Use **Kobalte** with *Solid UI* and `@kobalte/core`.",
        "",
        "- Accessible controls",
        "  - Keyboard support",
        "- [x] Tested",
        "",
        "> Keep the public API small.",
      ].join("\n"),
      status: undefined,
      attachments: [],
    },
  },
  render: (storyArgs) => <MessageBodySurface args={storyArgs} width="460px" />,
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("heading", { level: 2, name: "Recommendation" })).toBeInTheDocument();
    await expect(canvas.getByText("Kobalte").tagName).toBe("STRONG");
    await expect(canvas.getByRole("checkbox", { name: "Tested" })).toBeChecked();
  },
};

export const WorkspaceFileLinks: Story = {
  args: {
    message: {
      ...message,
      id: "message-workspace-file-links",
      body: [
        "Pliki:",
        "",
        "- [page.tsx](/Users/test/OpenBot/Agents/builder/app/page.tsx)",
        "- [globals.css](/Users/test/OpenBot/Agents/builder/app/globals.css)",
        "",
        "Gotowe: [otwórz tablicę Lutra w HTML](< lutra-brand-board.html >)",
      ].join("\n"),
      status: undefined,
      attachments: [],
    },
    onOpenWorkspaceFile: fn(),
  },
  render: (storyArgs) => <MessageBodySurface args={storyArgs} width="620px" />,
  play: async ({ args: storyArgs, canvas }) => {
    const pageLink = canvas.getByRole("button", { name: "Open workspace file page.tsx" });
    const cssLink = canvas.getByRole("button", { name: "Open workspace file globals.css" });
    const htmlLink = canvas.getByRole("button", { name: "Open workspace file lutra-brand-board.html" });
    await expect(pageLink).toHaveTextContent("page.tsx");
    await expect(cssLink).toHaveTextContent("globals.css");
    await expect(htmlLink).toHaveTextContent("otwórz tablicę Lutra w HTML");
    await expect(canvas.queryByText(/\/Users\/test\/OpenBot/u)).not.toBeInTheDocument();
    await expect(canvas.queryByText(/\(<|>\)/u)).not.toBeInTheDocument();
    pageLink.click();
    htmlLink.click();
    await expect(storyArgs.onOpenWorkspaceFile).toHaveBeenNthCalledWith(
      1,
      "/Users/test/OpenBot/Agents/builder/app/page.tsx",
    );
    await expect(storyArgs.onOpenWorkspaceFile).toHaveBeenNthCalledWith(2, "lutra-brand-board.html");
  },
};

export const CodeBlock: Story = {
  args: {
    message: {
      ...message,
      id: "message-code-block",
      body: [
        "The helper is ready:",
        "",
        "```ts churn.ts",
        "export async function churnBatch() {",
        '  const flavor = await getFlavor("pistachio");',
        "  const base = await dairy.fetch({ flavor });",
        '  await freezer.store(base, { temp: "-14C" });',
        "  return base.gallons;",
        "}",
        "```",
      ].join("\n"),
      status: undefined,
      attachments: [],
    },
  },
  render: (storyArgs) => <MessageBodySurface args={storyArgs} variant="ghost" width="460px" />,
  play: async ({ canvas }) => {
    await expect(canvas.getByText("The helper is ready:")).toBeInTheDocument();
    await expect(canvas.getByRole("region", { name: "TypeScript code block" })).toBeInTheDocument();
    await expect(canvas.getByText("churn.ts")).toBeInTheDocument();
    const copyButton = canvas.getByRole("button", { name: "Copy code" });
    await expect(copyButton.querySelectorAll("svg")).toHaveLength(2);
    await expect(copyButton.querySelector('.message-code-copy-icons > span[data-visible="true"]')).toBeInTheDocument();
    await expect(canvas.queryByText("```ts churn.ts")).not.toBeInTheDocument();
  },
};

export const StreamingCodeBlock: Story = {
  args: {
    message: {
      ...message,
      id: "message-streaming-code-block",
      body: [
        "```tsx AgentCard.tsx",
        "export function AgentCard(props: { name: string }) {",
        "  return <strong>{props.name}</strong>;",
      ].join("\n"),
      streaming: true,
      status: undefined,
      attachments: [],
    },
  },
  render: (storyArgs) => <MessageBodySurface args={storyArgs} variant="ghost" width="460px" />,
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("region", { name: "TypeScript code block" })).toBeInTheDocument();
    await expect(canvas.getByText("AgentCard.tsx")).toBeInTheDocument();
    const region = canvas.getByRole("region", { name: "TypeScript code block" });
    await expect(region.querySelector(".message-code-caret")).toBeInTheDocument();
  },
};

export const DataTable: Story = {
  args: {
    message: {
      ...message,
      id: "message-data-table",
      body: [
        "| Model | Context | $/1M in |",
        "| --- | --- | ---: |",
        "| gpt-4o | 128k | $5.00 |",
        "| claude-3.5 | 200k | $3.00 |",
        "| llama-3.1 | 128k | $0.90 |",
      ].join("\n"),
      status: undefined,
      attachments: [],
    },
  },
  render: (storyArgs) => <MessageBodySurface args={storyArgs} variant="ghost" width="460px" />,
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("table")).toBeInTheDocument();
    await expect(canvas.getAllByRole("columnheader")).toHaveLength(3);
    await expect(canvas.queryByText("| --- | --- | ---: |")).not.toBeInTheDocument();
  },
};

export const DataTableNarrow: Story = {
  args: {
    message: {
      ...message,
      id: "message-data-table-narrow",
      body: [
        "| Fixture | Market odds H/D/A | Implied H/D/A | Scenario | Pick |",
        "| --- | ---: | ---: | ---: | --- |",
        "| Ipswich–Liverpool | 5.25 / 4.60 / 1.57 | 18% / 21% / 61% | 20% / 22% / 58% | Liverpool win |",
        "| Newcastle–Bournemouth | 2.20 / 3.70 / 3.00 | 43% / 26% / 32% | 45% / 27% / 28% | Newcastle, cautiously |",
      ].join("\n"),
      status: undefined,
      attachments: [],
    },
  },
  render: (storyArgs) => <MessageBodySurface args={storyArgs} variant="ghost" width="320px" />,
  play: async ({ canvas }) => {
    const region = canvas.getByRole("region", { name: "Data table" });
    await expect(region.scrollWidth).toBeGreaterThan(region.clientWidth);
    const longFixture = canvas.getByText("Newcastle–Bournemouth");
    await expect(getComputedStyle(longFixture).textOverflow).toBe("clip");
  },
};

export const ComparisonTable: Story = {
  args: {
    message: {
      ...message,
      id: "message-comparison-table",
      body: [
        "| Feature | Personal | Enterprise |",
        "| --- | --- | --- |",
        "| Unlimited projects | ✓ | ✓ |",
        "| All components | ✓ | ✓ |",
        "| Team-wide usage | — | ✓ |",
        "| Priority support | — | ✓ |",
      ].join("\n"),
      status: undefined,
      attachments: [],
    },
  },
  render: (storyArgs) => <MessageBodySurface args={storyArgs} variant="ghost" width="460px" />,
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("region", { name: "Comparison table" })).toBeInTheDocument();
    await expect(canvas.getAllByRole("columnheader")).toHaveLength(3);
    await expect(canvas.getAllByText("✓")).toHaveLength(6);
    await expect(canvas.getAllByText("—")).toHaveLength(2);
  },
};

export const ComparisonTableNarrow: Story = {
  args: {
    message: {
      ...message,
      id: "message-comparison-table-narrow",
      body: [
        "| Feature | Free | Personal | Business | Enterprise |",
        "| --- | --- | --- | --- | --- |",
        "| Unlimited projects | — | ✓ | ✓ | ✓ |",
        "| Team-wide usage | — | — | ✓ | ✓ |",
        "| Priority support | — | — | — | ✓ |",
      ].join("\n"),
      status: undefined,
      attachments: [],
    },
  },
  render: (storyArgs) => <MessageBodySurface args={storyArgs} variant="ghost" width="320px" />,
  play: async ({ canvas }) => {
    const region = canvas.getByRole("region", { name: "Comparison table" });
    await expect(region.scrollWidth).toBeGreaterThan(region.clientWidth);
  },
};
