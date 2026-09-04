import type { AgentMemory } from "@openbot/contracts/ipc";
import { onCleanup } from "solid-js";
import { expect, fireEvent, fn, waitFor, within } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import AgentSettingsPanel from "../src/components/conversation/AgentSettingsPanel";
import { STORY_AGENT_STATUS, STORY_AGENTS, STORY_MODELS } from "./fixtures";
import { createMockOpenBot } from "./mock-openbot";

const chiefMemories: AgentMemory[] = [
  {
    id: "memory-automatic",
    agentId: "chief",
    text: "The user prefers short progress updates with the result first.",
    origin: "automatic",
    sourceTurnId: "turn-42",
    createdAt: "2026-08-22T09:15:00.000Z",
    updatedAt: "2026-08-24T14:30:00.000Z",
  },
  {
    id: "memory-manual",
    agentId: "chief",
    text: "Use Bun for package scripts in OpenBot.",
    origin: "manual",
    sourceTurnId: null,
    createdAt: "2026-08-23T11:00:00.000Z",
    updatedAt: "2026-08-23T11:00:00.000Z",
  },
  {
    id: "memory-decision",
    agentId: "chief",
    text: "Keep capabilities and group coordination outside memory version 1.",
    origin: "automatic",
    sourceTurnId: "turn-57",
    createdAt: "2026-08-24T16:20:00.000Z",
    updatedAt: "2026-08-24T16:20:00.000Z",
  },
];

const fullMemoryList: AgentMemory[] = Array.from({ length: 64 }, (_, index) => ({
  id: `memory-${index + 1}`,
  agentId: "chief",
  text: `Durable working preference ${index + 1}: keep the result clear and concise.`,
  origin: index % 3 === 0 ? "manual" : "automatic",
  sourceTurnId: index % 3 === 0 ? null : `turn-${index + 1}`,
  createdAt: "2026-08-24T14:30:00.000Z",
  updatedAt: "2026-08-24T14:30:00.000Z",
}));

function AgentMemoriesStory(props: { memories: AgentMemory[] }) {
  const previousApi = window.openbot;
  const mock = createMockOpenBot({ memories: { chief: props.memories } });
  window.openbot = mock.api;

  onCleanup(() => {
    mock.dispose();
    window.openbot = previousApi;
  });

  return (
    <main class="agent-memories-story-stage">
      <AgentSettingsPanel
        agent={STORY_AGENTS[0]}
        runtimeSettings={{
          provider: STORY_AGENTS[0].provider,
          model: STORY_AGENTS[0].model,
          reasoningEffort: STORY_AGENTS[0].reasoningEffort,
        }}
        agentStatus={STORY_AGENT_STATUS}
        modelOptions={STORY_MODELS}
        working={false}
        maxWidth={() => 640}
        onClose={fn()}
        onWidthChange={fn()}
        onUpdateAgent={async (agentId, updates) => {
          await mock.api.agent.updateAgent({ agentId, ...updates });
        }}
        onUpdateRuntimeSettings={async (agentId, _settings, updates) => {
          await mock.api.agent.updateAgent({ agentId, ...updates });
          return true;
        }}
        onSetAgentAvatar={async (agentId, image) => {
          await mock.api.agent.setAvatar({ agentId, image });
        }}
      />
    </main>
  );
}

const meta = {
  title: "Settings/Agent Memories",
  component: AgentSettingsPanel,
  args: {
    agent: STORY_AGENTS[0],
    runtimeSettings: {
      provider: STORY_AGENTS[0].provider,
      model: STORY_AGENTS[0].model,
      reasoningEffort: STORY_AGENTS[0].reasoningEffort,
    },
    agentStatus: STORY_AGENT_STATUS,
    modelOptions: STORY_MODELS,
    working: false,
    maxWidth: () => 640,
    onClose: fn(),
    onWidthChange: fn(),
    onUpdateAgent: fn(async () => undefined),
    onUpdateRuntimeSettings: fn(async () => true),
    onSetAgentAvatar: fn(async () => undefined),
  },
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta<typeof AgentSettingsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SettingsRow: Story = {
  render: () => <AgentMemoriesStory memories={chiefMemories} />,
  play: async ({ canvas }) => {
    await waitFor(() => expect(canvas.getByRole("button", { name: /Memories/ })).toHaveTextContent("3 saved"));
  },
};

export const OpenModal: Story = {
  render: () => <AgentMemoriesStory memories={chiefMemories} />,
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("button", { name: /Memories/ }));
    const body = within(document.body);
    const dialog = await body.findByRole("dialog", { name: "Memories" });
    await expect(dialog).toBeVisible();
    await expect(body.getAllByText("Learned automatically", { exact: false })[0]).toBeVisible();
    await expect(body.getByText("Added manually", { exact: false })).toBeVisible();
  },
};

export const AddComposer: Story = {
  render: () => <AgentMemoriesStory memories={chiefMemories} />,
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("button", { name: /Memories/ }));
    const body = within(document.body);
    await userEvent.click(await body.findByRole("button", { name: "Add memory" }));
    const input = body.getByRole("textbox", { name: "New memory" });
    await expect(input).toHaveFocus();
    await userEvent.type(input, "Prefers concise weekly summaries.");
    await expect(body.getByRole("button", { name: "Save memory" })).toHaveAttribute("data-variant", "default");
  },
};

export const Editing: Story = {
  render: () => <AgentMemoriesStory memories={chiefMemories} />,
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("button", { name: /Memories/ }));
    const body = within(document.body);
    const firstMemory = await body.findByRole("button", { name: /Edit memory: The user prefers/ });
    firstMemory.focus();
    await userEvent.keyboard("{Enter}");
    await expect(body.getByRole("textbox", { name: "Edit memory" })).toHaveFocus();
    await expect(body.getByRole("button", { name: "Save" })).toHaveAttribute("data-variant", "default");
  },
};

export const DeleteAction: Story = {
  render: () => <AgentMemoriesStory memories={chiefMemories} />,
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("button", { name: /Memories/ }));
    const body = within(document.body);
    await userEvent.click((await body.findAllByRole("button", { name: "Delete memory" }))[0]);
    await waitFor(() =>
      expect(body.queryByText("The user prefers short progress updates with the result first.")).toBeNull(),
    );
    await expect(body.queryByRole("dialog", { name: "Delete this memory?" })).toBeNull();
  },
};

export const ClearConfirmation: Story = {
  render: () => <AgentMemoriesStory memories={chiefMemories} />,
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("button", { name: /Memories/ }));
    const body = within(document.body);
    await userEvent.click(await body.findByRole("button", { name: "Clear all memories" }));
    await expect(await body.findByRole("dialog", { name: "Clear all memories?" })).toBeVisible();
    await expect(document.querySelector(".agent-memories-modal")).toBeVisible();
  },
};

export const FullList: Story = {
  render: () => <AgentMemoriesStory memories={fullMemoryList} />,
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("button", { name: /Memories/ }));
    const body = within(document.body);
    const list = await body.findByRole("list");
    await expect(await body.findByText("Durable working preference 64", { exact: false })).toBeInTheDocument();
    await expect(body.getByText("64 saved", { exact: false })).toBeVisible();
    await waitFor(() => expect(list).toHaveClass("scroll-fade-bottom"));
    await expect(list).not.toHaveClass("scroll-fade-top");
  },
};

export const FullListMiddle: Story = {
  render: () => <AgentMemoriesStory memories={fullMemoryList} />,
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("button", { name: /Memories/ }));
    const list = await within(document.body).findByRole("list");
    await waitFor(() => expect(list.scrollHeight).toBeGreaterThan(list.clientHeight));
    list.scrollTop = Math.round((list.scrollHeight - list.clientHeight) / 2);
    await fireEvent.scroll(list);
    await waitFor(() => expect(list).toHaveClass("scroll-fade-top", "scroll-fade-bottom"));
  },
};

export const FullListBottom: Story = {
  render: () => <AgentMemoriesStory memories={fullMemoryList} />,
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("button", { name: /Memories/ }));
    const list = await within(document.body).findByRole("list");
    await waitFor(() => expect(list.scrollHeight).toBeGreaterThan(list.clientHeight));
    list.scrollTop = list.scrollHeight - list.clientHeight;
    await fireEvent.scroll(list);
    await waitFor(() => expect(list).toHaveClass("scroll-fade-top"));
    await expect(list).not.toHaveClass("scroll-fade-bottom");
  },
};

export const EmptyState: Story = {
  render: () => <AgentMemoriesStory memories={[]} />,
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(await canvas.findByRole("button", { name: /Memories/ }));
    const body = within(document.body);
    await expect(await body.findByText("This agent has no saved memories yet.")).toBeVisible();
  },
};
