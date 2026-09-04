import type { AttachmentSummary, MessageReaction } from "@openbot/contracts/ipc";
import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, Show } from "solid-js";
import { expect, fn, waitFor, within } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { ChoiceCard } from "../src/components/ConversationPrompts";
import { MessageActions, MessageBody } from "../src/components/conversation/MessageRendering";
import {
  Bubble,
  BubbleContent,
  BubbleGroup,
  BubbleReactions,
  type BubbleVariant,
  Button,
  Heading,
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
  MessageGroup,
  MessageHeader,
  Text,
} from "../src/components/ui";
import type { AgentMessage } from "../src/data";
import { STORY_AGENTS, STORY_ATTACHMENTS } from "./fixtures";

const previewImage = new URL("../src/assets/openbot-logo-production.png", import.meta.url).href;
const generatedImage: AttachmentSummary = {
  id: "chat-primitives-generated-image",
  name: "observatory.png",
  size: 184_320,
  kind: "image",
  mimeType: "image/png",
  previewKind: "image",
  previewUrl: previewImage,
};

const assistantMessage: AgentMessage = {
  id: "chat-primitives-assistant",
  author: "agent",
  body: "The launch brief is ready. I tightened the milestones, assigned owners, and kept the rollout reversible.",
  time: "10:02",
  kind: "text",
};

const userMessage: AgentMessage = {
  id: "chat-primitives-user",
  author: "you",
  body: "Great — turn that into a checklist for the team.",
  time: "10:03",
  kind: "text",
};

const markdownMessage: AgentMessage = {
  id: "chat-primitives-markdown",
  author: "agent",
  body: [
    "## Launch checklist",
    "",
    "- Confirm the release owner",
    "- Run the focused regression suite",
    "- Keep the rollback command nearby",
    "",
    "> Ship deliberately, not nervously.",
  ].join("\n"),
  time: "10:04",
  kind: "text",
};

const codeMessage: AgentMessage = {
  id: "chat-primitives-code",
  author: "agent",
  body: [
    "Run the release checks from the workspace root:",
    "",
    "```bash",
    "bun run test",
    "bun run typecheck",
    "```",
  ].join("\n"),
  time: "10:05",
  kind: "text",
};

const tableMessage: AgentMessage = {
  id: "chat-primitives-table",
  author: "agent",
  body: [
    "| Surface | Owner | State |",
    "| --- | --- | --- |",
    "| Renderer | Ada | Ready |",
    "| API | Lin | Reviewing |",
    "| Release | Sam | Queued |",
  ].join("\n"),
  time: "10:06",
  kind: "text",
};

const imageMessage: AgentMessage = {
  id: "chat-primitives-image",
  author: "agent",
  body: "",
  time: "10:07",
  kind: "text",
  status: "completed",
  attachments: [generatedImage],
  imageGeneration: {
    prompt: "A quiet observatory above the clouds at blue hour",
    resolution: "1024 × 1024",
    aspectRatio: "square",
  },
};

const attachmentMessage: AgentMessage = {
  id: "chat-primitives-attachment",
  author: "agent",
  body: "",
  time: "10:08",
  kind: "text",
  attachments: [STORY_ATTACHMENTS[0]],
};

const streamingMessage: AgentMessage = {
  id: "chat-primitives-streaming",
  author: "agent",
  body: "I’m checking the final dependency graph and preparing the rollout notes…",
  time: "10:09",
  kind: "text",
  status: "streaming",
  streaming: true,
};

const messageBodyCallbacks = {
  onSelectAgent: fn(),
  onOpenLink: fn(),
  onPreview: fn(),
  onAttachmentAction: fn(),
  onDownload: fn(),
};
const onPrototypeReply = fn();

function PrototypeMessage(props: {
  message: AgentMessage;
  referencedMessage?: AgentMessage;
  variant?: BubbleVariant;
  actions?: boolean;
  reaction?: MessageReaction;
  onReply?: () => void;
}) {
  const [pickerOpen, setPickerOpen] = createSignal(false);
  const [moreOpen, setMoreOpen] = createSignal(false);
  const [expandedEmoji, setExpandedEmoji] = createSignal(false);
  const [copied, setCopied] = createSignal(false);
  const [reaction, setReaction] = createSignal<MessageReaction | null | undefined>(props.reaction);
  const message = createMemo<AgentMessage>(() => ({ ...props.message, reaction: reaction() }));
  const own = () => props.message.author === "you";
  const variant = () => props.variant ?? (own() ? "secondary" : "muted");

  return (
    <Message
      align={own() ? "end" : "start"}
      class={["chat-prototype-message", "message-entry", own() ? "message-entry-user" : "message-entry-agent"]}
      data-author={own() ? "user" : "assistant"}
      aria-label={`${own() ? "You" : "Assistant"} at ${props.message.time}`}
    >
      <MessageContent>
        <div class="message-shell">
          <Bubble
            align={own() ? "end" : "start"}
            variant={variant()}
            data-author={own() ? "user" : "assistant"}
            data-streaming={props.message.streaming ? "" : undefined}
          >
            <BubbleContent>
              <MessageBody
                message={message()}
                referencedMessage={props.referencedMessage}
                agents={STORY_AGENTS}
                {...messageBodyCallbacks}
              />
            </BubbleContent>
            <Show when={reaction()}>
              {(value) => (
                <BubbleReactions class="message-reaction-anchor" align={own() ? "start" : "end"}>
                  <Button
                    variant="ghost"
                    type="button"
                    class="message-reaction-pill"
                    aria-label={`Remove reaction ${value()}`}
                    onClick={() => setReaction(undefined)}
                  >
                    {value()}
                  </Button>
                </BubbleReactions>
              )}
            </Show>
          </Bubble>
          <Show when={props.actions}>
            <MessageActions
              message={message()}
              pickerOpen={pickerOpen()}
              moreOpen={moreOpen()}
              expandedEmoji={expandedEmoji()}
              copied={copied()}
              onTogglePicker={() => setPickerOpen((current) => !current)}
              onToggleMore={() => setMoreOpen((current) => !current)}
              onExpandEmoji={() => setExpandedEmoji((current) => !current)}
              onReact={(value) => {
                setReaction(value ?? undefined);
                setPickerOpen(false);
              }}
              onReply={props.onReply ?? fn()}
              onCopy={() => setCopied(true)}
            />
          </Show>
        </div>
        <MessageFooter>{props.message.streaming ? "Writing…" : props.message.time}</MessageFooter>
      </MessageContent>
    </Message>
  );
}

function RichSurface(props: { label: string; children: JSX.Element }) {
  return (
    <Message class="chat-prototype-message chat-prototype-rich-message" aria-label={props.label}>
      <MessageContent>
        <MessageHeader>{props.label}</MessageHeader>
        <Bubble variant="ghost">
          <BubbleContent>{props.children}</BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}

function PrototypeThread(props: { narrow?: boolean }) {
  return (
    <section
      class={props.narrow ? "chat-primitives-stage chat-primitives-stage-narrow" : "chat-primitives-stage"}
      aria-label="Integrated chat example"
    >
      <header class="chat-primitives-stage-header">
        <div>
          <Text variant="label">Chief</Text>
          <Text variant="caption" tone="muted">
            Product workspace · online
          </Text>
        </div>
        <span class="chat-primitives-live-dot" aria-hidden="true" />
      </header>
      <div class="chat-primitives-thread">
        <PrototypeMessage message={assistantMessage} actions reaction="👍" onReply={onPrototypeReply} />
        <PrototypeMessage message={userMessage} actions referencedMessage={assistantMessage} />
        <PrototypeMessage message={markdownMessage} actions />
        <PrototypeMessage
          message={codeMessage}
          referencedMessage={userMessage}
          variant="ghost"
          actions
          reaction="👀"
          onReply={onPrototypeReply}
        />
        <PrototypeMessage message={tableMessage} variant="ghost" actions reaction="✅" onReply={onPrototypeReply} />
        <PrototypeMessage message={imageMessage} variant="ghost" actions reaction="🎉" onReply={onPrototypeReply} />
        <PrototypeMessage
          message={attachmentMessage}
          variant="ghost"
          actions
          reaction="👍"
          onReply={onPrototypeReply}
        />
        <RichSurface label="Decision required">
          <ChoiceCard
            title="How should we release this?"
            hint="Choose the rollout strategy."
            choices={["Gradual rollout", "Internal preview", "Full release"]}
            customChoice="Different approach"
            onSubmit={async () => true}
          />
        </RichSurface>
        <PrototypeMessage message={streamingMessage} actions onReply={onPrototypeReply} />
      </div>
    </section>
  );
}

const meta = {
  title: "Conversation/Chat Primitives",
  component: Bubble,
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta<typeof Bubble>;

export default meta;
type Story = StoryObj<typeof meta>;

export const BubbleGallery: Story = {
  name: "Bubble variants",
  render: () => (
    <main class="foundation-story chat-primitives-story">
      <Heading as="h1" size="lg">
        Bubble surfaces
      </Heading>
      <Text tone="secondary">Seven treatments, two alignments, one stable composition.</Text>
      <section class="chat-primitives-gallery" aria-label="Bubble variants">
        {(
          [
            ["default", "Default · current user"],
            ["secondary", "Secondary · raised surface"],
            ["muted", "Muted · assistant response"],
            ["tinted", "Tinted · suggested action"],
            ["outline", "Outline · supporting content"],
            ["destructive", "Destructive · failed action"],
          ] as const
        ).map(([variant, label], index) => (
          <Bubble variant={variant} align={index % 2 === 0 ? "start" : "end"}>
            <BubbleContent>{label}</BubbleContent>
          </Bubble>
        ))}
        <Bubble variant="muted">
          <BubbleContent>Reactions stay anchored to the surface.</BubbleContent>
          <BubbleReactions overflowCount={2} role="img" aria-label="Reactions: eyes, rocket, and two more">
            <span aria-hidden="true">👀</span>
            <span aria-hidden="true">🚀</span>
          </BubbleReactions>
        </Bubble>
        <BubbleGroup>
          <Bubble variant="muted">
            <BubbleContent>Grouped messages share a tighter rhythm.</BubbleContent>
          </Bubble>
          <Bubble variant="muted">
            <BubbleContent>The sender remains easy to scan.</BubbleContent>
          </Bubble>
        </BubbleGroup>
        <Bubble variant="ghost">
          <BubbleContent>
            <div class="chat-primitives-ghost-sample">Ghost removes the second frame around rich content.</div>
          </BubbleContent>
        </Bubble>
      </section>
    </main>
  ),
};

export const MessageComposition: Story = {
  name: "Message composition",
  render: () => (
    <main class="foundation-story chat-primitives-story">
      <Heading as="h1" size="lg">
        Message composition
      </Heading>
      <section class="chat-primitives-stage chat-primitives-stage-compact" aria-label="Direct message example">
        <Message>
          <MessageAvatar>AC</MessageAvatar>
          <MessageContent>
            <MessageHeader>Alice Chen</MessageHeader>
            <Bubble variant="muted">
              <BubbleContent>I checked the launch notes and added the missing owner.</BubbleContent>
            </Bubble>
            <MessageFooter>10:14</MessageFooter>
          </MessageContent>
        </Message>
        <MessageGroup>
          <Message align="end">
            <MessageContent>
              <Bubble align="end">
                <BubbleContent>Perfect. I’ll review it now.</BubbleContent>
              </Bubble>
            </MessageContent>
          </Message>
          <Message align="end">
            <MessageContent>
              <Bubble align="end">
                <BubbleContent>Then we can ship the internal preview.</BubbleContent>
              </Bubble>
              <MessageFooter>10:15 · Delivered</MessageFooter>
            </MessageContent>
          </Message>
        </MessageGroup>
      </section>
    </main>
  ),
};

export const IntegratedMessages: Story = {
  name: "Integrated messages",
  render: () => <PrototypeThread />,
  play: async ({ canvas, userEvent }) => {
    onPrototypeReply.mockClear();
    const message = canvas.getByLabelText("Assistant at 10:05");
    const toolbar = within(message).getByRole("toolbar", { name: "Agent message actions" });
    const addReaction = within(toolbar).getByRole("button", { name: "Add reaction" });
    addReaction.focus();
    await waitFor(() => expect(toolbar).toBeVisible());

    await userEvent.click(addReaction);
    const picker = await within(message).findByRole("menu", { name: "Add reaction" });
    await userEvent.click(within(picker).getByRole("menuitemradio", { name: "React with 🎉" }));
    await expect(within(message).findByRole("button", { name: "Remove reaction 🎉" })).resolves.toBeVisible();

    const reply = within(toolbar).getByRole("button", { name: "Reply to Agent message" });
    reply.focus();
    await waitFor(() => expect(toolbar).toBeVisible());
    await userEvent.keyboard("{Enter}");
    await expect(onPrototypeReply).toHaveBeenCalledTimes(1);
  },
};

export const NarrowConversation: Story = {
  name: "Integrated messages narrow",
  render: () => <PrototypeThread narrow />,
  play: async ({ canvas }) => {
    const stage = canvas.getByRole("region", { name: "Integrated chat example" });
    await expect(stage.scrollWidth).toBeLessThanOrEqual(stage.clientWidth);
  },
};
