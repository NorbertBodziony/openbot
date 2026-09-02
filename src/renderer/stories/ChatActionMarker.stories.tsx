import { expect, fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { ChatActionMarker } from "../src/components/conversation/ChatActionMarker";
import { Heading, Text } from "../src/components/ui";
import type { BotProfile, ChatActionMarkerModel } from "../src/data";

const bots: BotProfile[] = [bot("research", "Research"), bot("sales", "Sales")];
const onSelectAgent = fn();
const onOpenRoutine = fn();
const onOpenHostedSite = fn();

const meta = {
  title: "Conversation/Chat Action Marker",
  component: ChatActionMarker,
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta<typeof ChatActionMarker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AllStates: Story = {
  render: () => (
    <main class="foundation-story">
      <Heading as="h1" size="lg">
        Chat action markers
      </Heading>
      <Text tone="secondary">Agent actions and permanent routine history use one marker.</Text>
      <section class="chat-primitives-gallery chat-action-marker-gallery" aria-label="Chat action marker states">
        <ChatActionMarker
          marker={agentMarker(
            [
              { agentId: "research", status: "completed" },
              { agentId: "sales", status: "running" },
            ],
            "in-progress",
          )}
          bots={bots}
          onSelectAgent={onSelectAgent}
        />
        <ChatActionMarker
          marker={{
            ...agentMarker([{ agentId: "chief", status: "completed" }], "completed"),
            direction: "incoming",
            sourceAgentId: "research",
          }}
          bots={bots}
          onSelectAgent={onSelectAgent}
        />
        {routineStatuses.map((status) => (
          <ChatActionMarker
            marker={routineMarker(status)}
            bots={bots}
            onSelectAgent={onSelectAgent}
            onOpenRoutine={onOpenRoutine}
          />
        ))}
        {routineActions.map((action) => (
          <ChatActionMarker
            marker={lifecycleMarker(action)}
            bots={bots}
            routineAvailable={action !== "deleted"}
            onSelectAgent={onSelectAgent}
            onOpenRoutine={onOpenRoutine}
          />
        ))}
        {siteActions.flatMap((action) =>
          siteStatuses.map((status) => (
            <ChatActionMarker
              marker={siteMarker(action, status)}
              bots={bots}
              onSelectAgent={onSelectAgent}
              onOpenHostedSite={onOpenHostedSite}
            />
          )),
        )}
        <ChatActionMarker
          marker={{ kind: "unavailable", label: "Action unavailable", timestamp: timestamp }}
          bots={bots}
          onSelectAgent={onSelectAgent}
        />
      </section>
    </main>
  ),
  play: async ({ canvas, userEvent }) => {
    onOpenRoutine.mockClear();
    await userEvent.click(canvas.getAllByRole("button", { name: "Open routine Morning brief" })[0]);
    await expect(onOpenRoutine).toHaveBeenCalledWith({ routineId: "routine-1", name: "Morning brief" });
  },
};

export const CompactAndUnavailable: Story = {
  render: () => (
    <main class="foundation-story">
      <Heading as="h1" size="lg">
        Compact markers
      </Heading>
      <section class="chat-primitives-stage chat-primitives-stage-narrow" aria-label="Compact chat action markers">
        <ChatActionMarker
          marker={{
            ...routineMarker("needs-attention"),
            routineName: "Portfolio review with a long unavailable routine name",
          }}
          bots={bots}
          routineAvailable={false}
          onSelectAgent={onSelectAgent}
          onOpenRoutine={onOpenRoutine}
        />
        <ChatActionMarker
          marker={agentMarker([{ agentId: "missing", status: "failed" }], "failed")}
          bots={bots}
          onSelectAgent={onSelectAgent}
        />
        <ChatActionMarker
          marker={{
            ...siteMarker("publish", "running"),
            title: "A very long public launch page title that must remain compact in a narrow conversation",
          }}
          bots={bots}
          onSelectAgent={onSelectAgent}
          onOpenHostedSite={onOpenHostedSite}
        />
      </section>
    </main>
  ),
};

export const ReducedMotion: Story = {
  render: () => (
    <main class="foundation-story">
      <Heading as="h1" size="lg">
        Reduced motion marker
      </Heading>
      <section class="chat-primitives-stage chat-primitives-stage-narrow" aria-label="Reduced motion chat marker">
        <ChatActionMarker
          marker={siteMarker("replace", "running")}
          bots={bots}
          onSelectAgent={onSelectAgent}
          onOpenHostedSite={onOpenHostedSite}
        />
      </section>
    </main>
  ),
  parameters: { chromatic: { prefersReducedMotion: "reduce" } },
};

const timestamp = "2026-09-01T08:00:00.000Z";
const routineStatuses: Array<Extract<ChatActionMarkerModel, { kind: "routine-run" }>["status"]> = [
  "queued",
  "running",
  "needs-attention",
  "succeeded",
  "failed",
  "interrupted",
  "cancelled",
];
const routineActions: Array<Extract<ChatActionMarkerModel, { kind: "routine-lifecycle" }>["action"]> = [
  "created",
  "updated",
  "deleted",
];
const siteActions: Array<Extract<ChatActionMarkerModel, { kind: "hosted-site" }>["action"]> = [
  "publish",
  "replace",
  "delete",
];
const siteStatuses: Array<Extract<ChatActionMarkerModel, { kind: "hosted-site" }>["status"]> = [
  "running",
  "succeeded",
  "failed",
  "interrupted",
  "cancelled",
];

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
    timestamp,
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
    runId: `run-${status}`,
    routineName: "Morning brief",
    status,
    timestamp,
  };
}

function lifecycleMarker(
  action: Extract<ChatActionMarkerModel, { kind: "routine-lifecycle" }>["action"],
): Extract<ChatActionMarkerModel, { kind: "routine-lifecycle" }> {
  return {
    kind: "routine-lifecycle",
    action,
    sourceAgentId: "chief",
    routineId: "routine-1",
    routineName: "Morning brief",
    status: "completed",
    timestamp,
  };
}

function siteMarker(
  action: Extract<ChatActionMarkerModel, { kind: "hosted-site" }>["action"],
  status: Extract<ChatActionMarkerModel, { kind: "hosted-site" }>["status"],
): Extract<ChatActionMarkerModel, { kind: "hosted-site" }> {
  const hasPublishedSite = action !== "publish" || status === "succeeded";
  return {
    kind: "hosted-site",
    sourceAgentId: "chief",
    action,
    status,
    operationId: `${action}-${status}`,
    siteId: hasPublishedSite ? "site-1" : null,
    title: "Launch page",
    hostname: hasPublishedSite ? "launch-page-23456789ab.openbot.site" : null,
    url: hasPublishedSite ? "https://launch-page-23456789ab.openbot.site" : null,
    timestamp,
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
