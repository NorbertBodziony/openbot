import type { Routine, RoutineRun } from "@openbot/contracts/ipc";
import { onCleanup } from "solid-js";
import { expect, fn, waitFor, within } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { AgentRoutinesSettings } from "../src/components/conversation/AgentRoutinesSettings";
import AgentSettingsPanel from "../src/components/conversation/AgentSettingsPanel";
import { STORY_AGENT_STATUS, STORY_BOTS, STORY_MODELS } from "./fixtures";
import { createMockOpenBot } from "./mock-openbot";

const morningBrief: Routine = {
  id: "routine-morning-brief",
  botId: "chief",
  name: "Morning brief",
  instruction: "Summarize the important market and product changes since yesterday.",
  active: true,
  timezone: "Europe/Warsaw",
  trigger: {
    id: "trigger-weekdays",
    routineId: "routine-morning-brief",
    schedule: { kind: "weekdays", time: "07:00" },
    nextRunAt: "2026-08-26T05:00:00.000Z",
    createdAt: "2026-08-25T09:00:00.000Z",
    updatedAt: "2026-08-25T09:00:00.000Z",
  },
  createdAt: "2026-08-25T09:00:00.000Z",
  updatedAt: "2026-08-25T09:00:00.000Z",
};

const weeklyPlanning: Routine = {
  id: "routine-weekly-planning",
  botId: "chief",
  name: "Weekly planning",
  instruction: "Review open work and prepare the priorities for next week.",
  active: false,
  timezone: "Europe/Warsaw",
  trigger: {
    id: "trigger-weekly-planning",
    routineId: "routine-weekly-planning",
    schedule: { kind: "weekly", weekday: 5, time: "16:00" },
    nextRunAt: "2026-08-28T14:00:00.000Z",
    createdAt: "2026-08-25T09:00:00.000Z",
    updatedAt: "2026-08-25T09:00:00.000Z",
  },
  createdAt: "2026-08-25T09:00:00.000Z",
  updatedAt: "2026-08-25T09:00:00.000Z",
};

const storyRoutines = [morningBrief, weeklyPlanning];

const fullPanelRuns: RoutineRun[] = [
  storyRun("run-today", "succeeded", "scheduled", 0),
  storyRun("run-manual", "needs-attention", "manual", 4),
  storyRun("run-yesterday", "failed", "scheduled", 28),
];

function RoutinesStory(props: { routines?: Routine[]; runs?: RoutineRun[] }) {
  const previousApi = window.openbot;
  const mock = createMockOpenBot({ routines: { chief: props.routines ?? storyRoutines } });
  window.openbot = mock.api;
  if (props.runs) mock.api.agent.listRoutineRuns = async () => structuredClone(props.runs ?? []);
  onCleanup(() => {
    mock.dispose();
    window.openbot = previousApi;
  });
  return (
    <main style={{ width: "380px", height: "720px", overflow: "auto", background: "var(--openbot-bg-canvas)" }}>
      <AgentRoutinesSettings botId="chief" onCountChange={fn()} onBack={fn()} onClose={fn()} />
    </main>
  );
}

function FullSettingsPanelStory() {
  const previousApi = window.openbot;
  const previousWidth = window.localStorage.getItem("openbot:settings-panel-width");
  const mock = createMockOpenBot({ routines: { chief: storyRoutines } });
  window.openbot = mock.api;
  mock.api.agent.listRoutineRuns = async (input) =>
    input.routineId === morningBrief.id ? structuredClone(fullPanelRuns) : [];
  window.localStorage.setItem("openbot:settings-panel-width", "380");

  onCleanup(() => {
    mock.dispose();
    window.openbot = previousApi;
    if (previousWidth === null) {
      window.localStorage.removeItem("openbot:settings-panel-width");
      return;
    }
    window.localStorage.setItem("openbot:settings-panel-width", previousWidth);
  });

  return (
    <main class="agent-memories-story-stage">
      <AgentSettingsPanel
        bot={STORY_BOTS[0]}
        runtimeSettings={{
          provider: STORY_BOTS[0].provider,
          model: STORY_BOTS[0].model,
          reasoningEffort: STORY_BOTS[0].reasoningEffort,
        }}
        agentStatus={STORY_AGENT_STATUS}
        modelOptions={STORY_MODELS}
        working={false}
        maxWidth={() => 640}
        onClose={fn()}
        onWidthChange={fn()}
        onUpdateBot={async (botId, updates) => {
          await mock.api.agent.updateBot({ botId, ...updates });
        }}
        onUpdateRuntimeSettings={async (botId, _settings, updates) => {
          await mock.api.agent.updateBot({ botId, ...updates });
          return true;
        }}
        onSetAgentAvatar={async (botId, image) => {
          await mock.api.agent.setAvatar({ botId, image });
        }}
      />
    </main>
  );
}

const meta = {
  title: "Settings/Agent Routines",
  component: AgentRoutinesSettings,
  args: { botId: "chief", onCountChange: fn() },
  parameters: { layout: "centered", a11y: { test: "error" } },
} satisfies Meta<typeof AgentRoutinesSettings>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RoutineList: Story = {
  render: () => <RoutinesStory />,
  play: async ({ canvas }) => {
    await expect(await canvas.findByRole("button", { name: /Morning brief/ })).toHaveTextContent("Weekdays at");
  },
};

export const RoutineEditor: Story = {
  render: () => <RoutinesStory />,
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("button", { name: /Morning brief/ }));
    await expect(canvas.getByRole("heading", { name: "Routine" })).toBeVisible();
    await expect(canvas.getByDisplayValue("Morning brief")).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Test run" })).toBeEnabled();
    await expect(canvas.queryByRole("button", { name: "Add another" })).not.toBeInTheDocument();
  },
};

export const EmptyDraft: Story = {
  render: () => <RoutinesStory routines={[]} />,
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("button", { name: "Create Routine" }));
    await expect(canvas.getByPlaceholderText("Morning brief")).toHaveValue("");
    await userEvent.click(canvas.getByRole("button", { name: "Back to Routines" }));
    await expect(canvas.getByText("No routines yet.")).toBeVisible();
  },
};

export const UnsavedChangesConfirmation: Story = {
  render: () => <RoutinesStory />,
  play: async ({ canvas, canvasElement, userEvent }) => {
    await userEvent.click(await canvas.findByRole("button", { name: /Morning brief/ }));
    await userEvent.clear(canvas.getByRole("textbox", { name: "Name" }));
    await userEvent.type(canvas.getByRole("textbox", { name: "Name" }), "Changed morning brief");
    await userEvent.click(canvas.getByRole("button", { name: "Back to Routines" }));
    const body = within(canvasElement.ownerDocument.body);
    await expect(await body.findByRole("dialog")).toHaveAccessibleName("Discard changes?");
    await expect(body.getByRole("button", { name: "Keep editing" })).toBeInTheDocument();
    await expect(body.getByRole("button", { name: "Discard changes" })).toBeInTheDocument();
  },
};

export const OpenTimePicker: Story = {
  render: () => <RoutinesStory />,
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("button", { name: /Morning brief/ }));
    await userEvent.click(canvas.getByRole("button", { name: /On weekdays at 7:00 AM/ }));
    await userEvent.click(canvas.getByRole("button", { name: /^Time/ }));
    await expect(canvas.getByRole("button", { name: /^Time/ })).toHaveTextContent("7:00 AM");
  },
};

const runStatuses: RoutineRun["status"][] = [
  "queued",
  "running",
  "needs-attention",
  "succeeded",
  "failed",
  "interrupted",
  "cancelled",
];

export const RunHistoryStatuses: Story = {
  render: () => (
    <RoutinesStory
      runs={runStatuses.map((status, index) => ({
        id: `run-${status}`,
        routineId: morningBrief.id,
        botId: morningBrief.botId,
        triggerId: morningBrief.trigger.id,
        kind: index === 0 ? "manual" : "scheduled",
        scheduledFor: new Date(Date.now() - index * 3_600_000).toISOString(),
        routineName: morningBrief.name,
        instruction: morningBrief.instruction,
        deliveryId: `delivery-${status}`,
        status,
        error: status === "failed" ? "Example failure" : null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }))}
    />
  ),
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("button", { name: /Morning brief/ }));
    for (const status of runStatuses) {
      const label = status === "needs-attention" ? "Needs attention" : `${status[0]?.toUpperCase()}${status.slice(1)}`;
      await expect(await canvas.findByRole("img", { name: label })).toBeVisible();
    }
  },
};

export const FullSidePanel: Story = {
  render: () => <FullSettingsPanelStory />,
  parameters: { layout: "fullscreen" },
  play: async ({ canvas }) => {
    await waitFor(() => expect(canvas.getByRole("button", { name: /Routines/ })).toHaveTextContent("2 configured"));
    await expect(canvas.getByLabelText("Agent name")).toHaveValue("Chief");
    await expect(canvas.getByRole("switch", { name: "Notifications" })).toBeChecked();
  },
};

export const FullSidePanelRoutines: Story = {
  render: () => <FullSettingsPanelStory />,
  parameters: { layout: "fullscreen" },
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("button", { name: /Routines/ }));
    await expect(canvas.queryByRole("button", { name: "Edit agent avatar" })).not.toBeInTheDocument();
    await expect(await canvas.findByRole("button", { name: /Morning brief/ })).toHaveTextContent("Weekdays at");
    await expect(canvas.getByRole("button", { name: /Weekly planning/ })).toHaveTextContent("Paused");
  },
};

export const FullSidePanelRoutineEditor: Story = {
  render: () => <FullSettingsPanelStory />,
  parameters: { layout: "fullscreen" },
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("button", { name: /Routines/ }));
    await userEvent.click(await canvas.findByRole("button", { name: /Morning brief/ }));
    await expect(canvas.getByDisplayValue("Morning brief")).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Test run" })).toBeEnabled();
    await expect(await canvas.findByRole("img", { name: "Succeeded" })).toBeVisible();
    await expect(canvas.getByRole("img", { name: "Needs attention" })).toBeVisible();
  },
};

function storyRun(id: string, status: RoutineRun["status"], kind: RoutineRun["kind"], hoursAgo: number): RoutineRun {
  const scheduledFor = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
  return {
    id,
    routineId: morningBrief.id,
    botId: morningBrief.botId,
    triggerId: kind === "manual" ? null : morningBrief.trigger.id,
    kind,
    scheduledFor,
    routineName: morningBrief.name,
    instruction: morningBrief.instruction,
    deliveryId: `delivery-${id}`,
    status,
    error: status === "failed" ? "The agent could not complete this run." : null,
    createdAt: scheduledFor,
    updatedAt: scheduledFor,
  };
}
