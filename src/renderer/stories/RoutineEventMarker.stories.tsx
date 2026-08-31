import { Match, Switch } from "solid-js";
import { expect, fn, waitFor, within } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { type RoutineEventAction, RoutineEventMarker } from "../src/components/conversation/RoutineEventMarker";
import { Bubble, BubbleContent, Heading, Message, MessageContent, MessageFooter, Text } from "../src/components/ui";

interface RoutineEventStoryArgs {
  action: RoutineEventAction;
  routineId: string;
  routineName: string;
  onOpenRoutine: (routineId: string) => void;
}

const onPlaygroundOpenRoutine = fn();
const onCreatedRoutine = fn();
const onUpdatedRoutine = fn();
const onContextOpenRoutine = fn();

function StoryRoutineEventMarker(props: RoutineEventStoryArgs) {
  return (
    <Switch
      fallback={
        <RoutineEventMarker
          action="created"
          routineId={props.routineId}
          routineName={props.routineName}
          onOpenRoutine={props.onOpenRoutine}
        />
      }
    >
      <Match when={props.action === "updated"}>
        <RoutineEventMarker
          action="updated"
          routineId={props.routineId}
          routineName={props.routineName}
          onOpenRoutine={props.onOpenRoutine}
        />
      </Match>
      <Match when={props.action === "deleted"}>
        <RoutineEventMarker action="deleted" routineId={props.routineId} routineName={props.routineName} />
      </Match>
    </Switch>
  );
}

function StoryMessage(props: { author: "assistant" | "user"; children: string; time: string }) {
  const own = () => props.author === "user";
  return (
    <Message align={own() ? "end" : "start"} class="chat-prototype-message message-entry">
      <MessageContent>
        <Bubble align={own() ? "end" : "start"} variant={own() ? "secondary" : "muted"}>
          <BubbleContent>{props.children}</BubbleContent>
        </Bubble>
        <MessageFooter>{props.time}</MessageFooter>
      </MessageContent>
    </Message>
  );
}

function ConversationPreview(props: { narrow?: boolean }) {
  return (
    <section
      class={props.narrow ? "chat-primitives-stage chat-primitives-stage-narrow" : "chat-primitives-stage"}
      aria-label={props.narrow ? "Narrow routine event conversation" : "Routine event conversation"}
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
        <StoryMessage author="user" time="10:02">
          Please prepare a Kraków weather update every morning.
        </StoryMessage>
        <RoutineEventMarker
          action={props.narrow ? "updated" : "created"}
          routineId="routine-weather-krakow"
          routineName={props.narrow ? "Pogoda Kraków with a detailed morning forecast" : "Pogoda Kraków"}
          onOpenRoutine={onContextOpenRoutine}
        />
        <StoryMessage author="assistant" time="10:03">
          Done. I will include temperature, rain, wind, and alerts.
        </StoryMessage>
      </div>
    </section>
  );
}

const meta = {
  title: "Conversation/Routine Event Marker",
  component: StoryRoutineEventMarker,
  args: {
    action: "created",
    routineId: "routine-weather-krakow",
    routineName: "Pogoda Kraków",
    onOpenRoutine: onPlaygroundOpenRoutine,
  },
  argTypes: {
    action: { control: "select", options: ["created", "updated", "deleted"] },
    routineId: { control: false },
    onOpenRoutine: { control: false },
  },
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta<typeof StoryRoutineEventMarker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  render: (args) => (
    <main class="foundation-story">
      <Heading as="h1" size="lg">
        Routine event marker
      </Heading>
      <Text tone="secondary">Use the controls to compare routine event states and names.</Text>
      <section class="chat-primitives-gallery" aria-label="Routine event marker playground">
        <StoryRoutineEventMarker {...args} />
      </section>
    </main>
  ),
};

export const AllStates: Story = {
  render: () => (
    <main class="foundation-story">
      <Heading as="h1" size="lg">
        Routine event states
      </Heading>
      <Text tone="secondary">
        Created and updated routines open their settings. Deleted routines remain as history.
      </Text>
      <section class="chat-primitives-gallery" aria-label="Routine event marker states">
        <RoutineEventMarker
          action="created"
          routineId="routine-weather-krakow"
          routineName="Pogoda Kraków"
          onOpenRoutine={onCreatedRoutine}
        />
        <RoutineEventMarker
          action="updated"
          routineId="routine-morning-brief"
          routineName="Morning brief"
          onOpenRoutine={onUpdatedRoutine}
        />
        <RoutineEventMarker action="deleted" routineId="routine-old-sync" routineName="Old portfolio sync" />
      </section>
    </main>
  ),
  play: async ({ canvas, userEvent }) => {
    onCreatedRoutine.mockClear();
    onUpdatedRoutine.mockClear();

    await userEvent.click(canvas.getByRole("button", { name: "Open routine Pogoda Kraków" }));
    await expect(onCreatedRoutine).toHaveBeenCalledWith("routine-weather-krakow");

    await userEvent.click(canvas.getByRole("button", { name: "Open routine Morning brief" }));
    await expect(onUpdatedRoutine).toHaveBeenCalledWith("routine-morning-brief");

    await expect(canvas.queryByRole("button", { name: /Old portfolio sync/ })).not.toBeInTheDocument();
    const deletedPill = canvas.getByLabelText("Old portfolio sync, deleted");
    const body = within(document.body);

    await userEvent.hover(deletedPill);
    await expect(await body.findByRole("tooltip")).toHaveTextContent("Deleted");
    await userEvent.unhover(deletedPill);
    await waitFor(() => expect(body.queryByRole("tooltip")).not.toBeInTheDocument());

    deletedPill.focus();
    await expect(deletedPill).toHaveFocus();
    await expect(await body.findByRole("tooltip")).toHaveTextContent("Deleted");
    await userEvent.keyboard("{Escape}");
    await expect(body.queryByRole("tooltip")).not.toBeInTheDocument();
  },
};

export const InConversation: Story = {
  render: () => (
    <main class="foundation-story">
      <Heading as="h1" size="lg">
        Routine events in a conversation
      </Heading>
      <div class="routine-event-context-grid">
        <ConversationPreview />
        <ConversationPreview narrow />
      </div>
    </main>
  ),
};
