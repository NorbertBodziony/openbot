import type { DynamicIslandAction, DynamicIslandBotIdentity, DynamicIslandPresentation } from "@openbot/contracts/ipc";
import type { JSX } from "@solidjs/web";
import { createMemo } from "solid-js";
import { expect, fireEvent, fn, waitFor, within } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { OpenBotDynamicIsland } from "../src/components/OpenBotDynamicIsland";
import type { DynamicIslandViewState } from "../src/components/ui";
import { DynamicIslandDisplayComparison } from "./DynamicIslandDisplayComparison";
import { STORY_BOTS } from "./fixtures";

type Scenario = "idle" | "working" | "chat" | "question" | "approval";
type QuestionVariant = "standard" | "short" | "long" | "multiple";

interface DynamicIslandDemoProps {
  scenario: Scenario;
  questionVariant?: QuestionVariant;
  defaultState?: DynamicIslandViewState;
  onAction: (action: DynamicIslandAction) => void;
  onSecondaryAction: () => void;
}

const BOT_IDENTITIES = STORY_BOTS.slice(0, 3).map(toIslandBot);

function DynamicIslandDemo(props: DynamicIslandDemoProps): JSX.Element {
  const presentation = createMemo(() => presentationFor(props.scenario, props.questionVariant ?? "standard"));

  return (
    <DynamicIslandDisplayComparison
      defaultState={props.defaultState}
      renderIsland={(preview) => (
        <OpenBotDynamicIsland
          presentation={presentation()}
          state={preview.state()}
          displayMode={preview.displayMode}
          onStateChange={preview.onStateChange}
          onAction={props.onAction}
          onLater={props.onSecondaryAction}
        />
      )}
    />
  );
}

function presentationFor(scenario: Scenario, questionVariant: QuestionVariant): DynamicIslandPresentation {
  const base = {
    serverId: "local",
    activeCount: 0,
    unreadCount: 0,
    attentionCount: 0,
    working: [],
    message: null,
    attention: [],
  } satisfies Omit<DynamicIslandPresentation, "mode">;

  if (scenario === "working") {
    return {
      ...base,
      mode: "working",
      activeCount: 3,
      working: [
        { bot: BOT_IDENTITIES[0], task: "Planning the launch sequence" },
        { bot: BOT_IDENTITIES[1], task: "Checking primary sources" },
        { bot: BOT_IDENTITIES[2], task: "Drafting partner follow-ups" },
      ],
    };
  }

  if (scenario === "chat") {
    return {
      ...base,
      mode: "message",
      unreadCount: 2,
      message: {
        bot: BOT_IDENTITIES[1],
        messageId: "research-reply",
        text: "I found three reliable sources. The market data supports the main claim.",
        createdAt: "2026-08-28T10:42:00.000Z",
      },
    };
  }

  if (scenario === "question") {
    const question = questionFixture(questionVariant);
    return {
      ...base,
      mode: "question",
      attentionCount: 1,
      attention: [question],
    };
  }

  if (scenario === "approval") {
    return {
      ...base,
      mode: "approval",
      attentionCount: 1,
      attention: [
        {
          id: "chief-command-approval",
          requestId: "chief-command-approval",
          bot: BOT_IDENTITIES[0],
          kind: "approval",
          title: "Command needs review",
          detail: "Chief needs to install the verified workspace dependencies before tests can run.",
          options: null,
          questions: null,
          approval: {
            kind: "command",
            command: "bun install --frozen-lockfile",
            cwd: "~/Projects/openbot",
            reason: "Install the locked dependencies before running the test suite.",
            grantRoot: null,
            permissions: null,
          },
        },
      ],
    };
  }

  return { ...base, mode: "idle" };
}

function questionFixture(variant: QuestionVariant): DynamicIslandPresentation["attention"][number] {
  if (variant === "short") {
    const options = [
      { label: "Send it", description: "Use this draft" },
      { label: "Revise", description: "Make one more pass" },
    ];
    return {
      id: "siema-tone-question",
      requestId: "siema-tone-question",
      bot: { ...BOT_IDENTITIES[1], id: "siema", name: "Siema", avatarSeed: "siema" },
      kind: "prompt",
      title: "Send this version?",
      detail: "The draft is ready.",
      options,
      questions: [
        {
          id: "send-version",
          header: "Send this version?",
          question: "The draft is ready. Which version should I use?",
          isSecret: false,
          options,
        },
      ],
      approval: null,
    };
  }

  if (variant === "long") {
    const options = [
      {
        label: "Official government statistics",
        description: "Use the latest public dataset with its conservative regional definition",
      },
      {
        label: "Detailed international industry report",
        description: "Use the paid report with broader coverage and a newer reporting period",
      },
      {
        label: "Triangulate every available source",
        description: "Compare the datasets and explain the difference in the final answer",
      },
    ];
    return {
      id: "international-market-research-source-question",
      requestId: "international-market-research-source-question",
      bot: {
        ...BOT_IDENTITIES[1],
        id: "international-market-research",
        name: "International Market Research, Competitive Intelligence, and Strategic Operations",
        avatarSeed: "international-market-research",
      },
      kind: "prompt",
      title: "Choose the primary evidence source for the international market-size estimate.",
      detail:
        "Which source should I cite when the available datasets use different regional definitions and reporting periods?",
      options,
      questions: [
        {
          id: "primary-evidence-source",
          header: "Choose the primary evidence source for the international market-size estimate.",
          question:
            "Which source should I cite when the available datasets use different regional definitions and reporting periods?",
          isSecret: false,
          options,
        },
      ],
      approval: null,
    };
  }

  if (variant === "multiple") {
    const sourceOptions = [
      { label: "Official data", description: "Use the latest government dataset" },
      { label: "Industry report", description: "Use the detailed paid report" },
      { label: "Use both", description: "Compare both sources and explain the difference" },
    ];
    return {
      id: "research-multiple-question",
      requestId: "research-multiple-question",
      bot: BOT_IDENTITIES[1],
      kind: "prompt",
      title: "Choose a source",
      detail: "Which source should I use for the market-size estimate?",
      options: sourceOptions,
      questions: [
        {
          id: "source",
          header: "Choose a source",
          question: "Which source should I use for the market-size estimate?",
          isSecret: false,
          options: sourceOptions,
        },
        {
          id: "format",
          header: "Choose the output format",
          question: "How should I present the final comparison?",
          isSecret: false,
          options: [
            { label: "Short summary", description: "Lead with the main conclusion" },
            { label: "Comparison table", description: "Show the differences side by side" },
            { label: "Detailed memo", description: "Include methods, caveats, and citations" },
          ],
        },
      ],
      approval: null,
    };
  }

  const options = [
    { label: "Official data", description: "Use the latest government dataset" },
    { label: "Industry report", description: "Use the detailed paid report" },
    { label: "Use both", description: "Compare both sources and explain the difference" },
  ];
  return {
    id: "research-source-question",
    requestId: "research-source-question",
    bot: BOT_IDENTITIES[1],
    kind: "prompt",
    title: "Choose a source",
    detail: "Which source should I use for the market-size estimate?",
    options,
    questions: [
      {
        id: "source",
        header: "Choose a source",
        question: "Which source should I use for the market-size estimate?",
        isSecret: false,
        options,
      },
    ],
    approval: null,
  };
}

function toIslandBot(bot: (typeof STORY_BOTS)[number]): DynamicIslandBotIdentity {
  return {
    id: bot.id,
    name: bot.name,
    avatarSeed: bot.avatarSeed,
    avatarHue: bot.avatarHue,
    avatarUrl: bot.avatarUrl,
  };
}

const meta = {
  title: "Experiments/macOS Dynamic Island",
  component: DynamicIslandDemo,
  args: {
    scenario: "working",
    defaultState: "compact",
    onAction: fn(),
    onSecondaryAction: fn(),
  },
  argTypes: {
    scenario: { control: "select", options: ["idle", "working", "chat", "question", "approval"] },
    questionVariant: { control: "select", options: ["standard", "short", "long", "multiple"] },
    defaultState: { control: "select", options: ["compact", "expanded"] },
  },
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta<typeof DynamicIslandDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Idle: Story = { args: { scenario: "idle", onAction: fn() } };

export const WorkingBots: Story = {
  args: { scenario: "working", onAction: fn() },
  play: async ({ args, canvas, userEvent }) => {
    const builtIn = within(canvas.getByRole("region", { name: "Built-in display preview" }));
    const external = within(canvas.getByRole("region", { name: "External display preview" }));
    builtIn.getByRole("button", { name: "Expand OpenBot working status" }).focus();
    await userEvent.keyboard("{Enter}");
    await expect(
      external.getByRole("button", { name: "Expand OpenBot working status on external display" }),
    ).toBeVisible();
    await userEvent.click(builtIn.getByRole("button", { name: /Chief/ }));
    await expect(args.onAction).toHaveBeenCalledOnce();
    await userEvent.keyboard("{Escape}");
    await expect(builtIn.getByRole("button", { name: "Expand OpenBot working status" })).toHaveFocus();
    await userEvent.keyboard(" ");
    await expect(builtIn.getByRole("button", { name: "Collapse OpenBot working status" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
  },
};

export const ChatUpdate: Story = {
  args: { scenario: "chat", defaultState: "compact", onAction: fn() },
  play: async ({ args, canvas, userEvent }) => {
    const builtIn = within(canvas.getByRole("region", { name: "Built-in display preview" }));
    await userEvent.hover(builtIn.getByRole("button", { name: "Expand OpenBot chat update" }));
    await waitFor(() => expect(builtIn.getByRole("button", { name: "Open chat" })).toBeVisible());
    await userEvent.click(builtIn.getByRole("button", { name: "Open chat" }));
    await expect(args.onAction).toHaveBeenCalledOnce();
    await userEvent.keyboard("{Escape}");
  },
};

export const QuestionFromAI: Story = {
  args: { scenario: "question", questionVariant: "standard", onAction: fn(), onSecondaryAction: fn() },
};

export const QuestionFromAIShort: Story = {
  args: {
    scenario: "question",
    questionVariant: "short",
    defaultState: "expanded",
    onAction: fn(),
    onSecondaryAction: fn(),
  },
};

export const QuestionFromAILong: Story = {
  args: {
    scenario: "question",
    questionVariant: "long",
    defaultState: "expanded",
    onAction: fn(),
    onSecondaryAction: fn(),
  },
};

export const QuestionFromAIMultiple: Story = {
  args: {
    scenario: "question",
    questionVariant: "multiple",
    defaultState: "expanded",
    onAction: fn(),
    onSecondaryAction: fn(),
  },
};

export const NeedsApproval: Story = {
  args: { scenario: "approval", onAction: fn() },
  play: async ({ args, canvas, userEvent }) => {
    const builtIn = within(canvas.getByRole("region", { name: "Built-in display preview" }));
    const island = builtIn.getByRole("region", { name: "OpenBot approval request" });
    const toggle = within(island).getByRole("button", { name: "Expand OpenBot approval request" });
    toggle.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(builtIn.getByText("Chief needs approval")).toBeVisible());
    await waitFor(() => expect(builtIn.getByText("bun install --frozen-lockfile")).toBeVisible());
    const approve = builtIn.getByRole("button", { name: "Approve" });
    await fireEvent.click(approve);
    await expect(args.onAction).toHaveBeenCalledWith({
      type: "approve-attention",
      serverId: "local",
      botId: "chief",
      requestId: "chief-command-approval",
    });
    await userEvent.keyboard("{Escape}");
  },
};
