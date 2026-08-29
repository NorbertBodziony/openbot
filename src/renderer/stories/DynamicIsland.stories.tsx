import type { DynamicIslandAction, DynamicIslandBotIdentity, DynamicIslandPresentation } from "@openbot/contracts/ipc";
import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For } from "solid-js";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { OpenBotDynamicIsland } from "../src/components/OpenBotDynamicIsland";
import { Button, type DynamicIslandViewState } from "../src/components/ui";
import { DynamicIslandDisplayComparison } from "./DynamicIslandDisplayComparison";
import { STORY_BOTS } from "./fixtures";

type Scenario = "idle" | "working" | "chat" | "question" | "approval" | "takeover" | "failed";
type QuestionVariant = "standard" | "short" | "long" | "multiple";
type WorkingVariant = "single" | "multiple";

interface DynamicIslandDemoProps {
  scenario: Scenario;
  questionVariant?: QuestionVariant;
  workingVariant?: WorkingVariant;
  defaultState?: DynamicIslandViewState;
  onAction: (action: DynamicIslandAction) => void;
  onSecondaryAction: () => void;
}

const BOT_IDENTITIES = STORY_BOTS.slice(0, 3).map(toIslandBot);

function DynamicIslandDemo(props: DynamicIslandDemoProps): JSX.Element {
  const presentation = createMemo(() =>
    presentationFor(props.scenario, props.questionVariant ?? "standard", props.workingVariant ?? "multiple"),
  );

  return (
    <DynamicIslandDisplayComparison
      defaultState={props.defaultState}
      renderIsland={(preview) => (
        <OpenBotDynamicIsland
          presentation={presentation()}
          state={preview.state()}
          displayMode={preview.displayMode}
          suppressInitialHover
          onStateChange={preview.onStateChange}
          onAction={props.onAction}
          onLater={props.onSecondaryAction}
        />
      )}
    />
  );
}

function DynamicIslandTransitionDemo(
  props: Pick<DynamicIslandDemoProps, "onAction" | "onSecondaryAction">,
): JSX.Element {
  const scenarios: Array<{ value: Scenario; label: string }> = [
    { value: "idle", label: "Idle" },
    { value: "working", label: "Working" },
    { value: "chat", label: "Chat" },
    { value: "question", label: "Question" },
    { value: "approval", label: "Approval" },
    { value: "takeover", label: "Takeover" },
    { value: "failed", label: "Failed" },
  ];
  const [scenario, setScenario] = createSignal<Scenario>("idle");
  const [state, setState] = createSignal<DynamicIslandViewState>("compact");
  const presentation = createMemo(() => presentationFor(scenario(), "standard", "multiple"));

  function selectScenario(next: Scenario): void {
    setScenario(next);
    if (next === "idle") setState("compact");
  }

  return (
    <DynamicIslandDisplayComparison
      state={state}
      onStateChange={setState}
      controls={
        <fieldset class="dynamic-island-story-mode-controls" aria-label="Dynamic Island mode">
          <For each={scenarios}>
            {(option) => (
              <Button
                size="xs"
                variant={scenario() === option.value ? "default" : "secondary"}
                aria-pressed={scenario() === option.value ? "true" : "false"}
                onClick={() => {
                  selectScenario(option.value);
                }}
              >
                {option.label}
              </Button>
            )}
          </For>
          <span class="dynamic-island-story-mode-divider" aria-hidden="true" />
          <Button
            size="xs"
            variant="outline"
            disabled={scenario() === "idle"}
            onClick={() => setState(state() === "expanded" ? "compact" : "expanded")}
          >
            {state() === "expanded" ? "Show compact" : "Show expanded"}
          </Button>
        </fieldset>
      }
      renderIsland={(preview) => (
        <OpenBotDynamicIsland
          presentation={presentation()}
          state={preview.state()}
          displayMode={preview.displayMode}
          suppressInitialHover
          onStateChange={preview.onStateChange}
          onAction={props.onAction}
          onLater={props.onSecondaryAction}
        />
      )}
    />
  );
}

function presentationFor(
  scenario: Scenario,
  questionVariant: QuestionVariant,
  workingVariant: WorkingVariant,
): DynamicIslandPresentation {
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
    const working = [
      { bot: BOT_IDENTITIES[0], task: "Planning the launch sequence" },
      { bot: BOT_IDENTITIES[1], task: "Checking primary sources" },
      { bot: BOT_IDENTITIES[2], task: "Drafting partner follow-ups" },
    ];
    const visibleWorking = workingVariant === "single" ? working.slice(0, 1) : working;
    return {
      ...base,
      mode: "working",
      activeCount: visibleWorking.length,
      working: visibleWorking,
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

  if (scenario === "takeover") {
    return {
      ...base,
      mode: "takeover",
      attentionCount: 1,
      attention: [
        {
          id: "chief-browser-takeover",
          requestId: "chief-browser-takeover",
          bot: BOT_IDENTITIES[0],
          kind: "takeover",
          title: "Browser step needs you",
          detail: "Complete the sign-in, verification, or consent in the browser.",
          options: null,
          questions: null,
          approval: null,
        },
      ],
    };
  }

  if (scenario === "failed") {
    return {
      ...base,
      mode: "failed",
      attentionCount: 1,
      attention: [
        {
          id: "research-failed-turn",
          requestId: "research-failed-turn",
          bot: BOT_IDENTITIES[1],
          kind: "failure",
          title: "Task failed",
          detail: "The browser tab closed before Research could finish collecting the sources.",
          options: null,
          questions: null,
          approval: null,
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
    scenario: {
      control: "select",
      options: ["idle", "working", "chat", "question", "approval", "takeover", "failed"],
    },
    questionVariant: { control: "select", options: ["standard", "short", "long", "multiple"] },
    workingVariant: { control: "select", options: ["single", "multiple"] },
    defaultState: { control: "select", options: ["compact", "expanded"] },
  },
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta<typeof DynamicIslandDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Idle: Story = { args: { scenario: "idle", onAction: fn() } };

export const WorkingBots: Story = {
  args: { scenario: "working", workingVariant: "multiple", onAction: fn() },
};

export const WorkingBot: Story = {
  args: { scenario: "working", workingVariant: "single", onAction: fn() },
};

export const ChatUpdate: Story = {
  args: { scenario: "chat", defaultState: "compact", onAction: fn() },
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
};

export const BrowserTakeover: Story = {
  args: { scenario: "takeover", onAction: fn() },
};

export const TaskFailed: Story = {
  args: { scenario: "failed", onAction: fn() },
};

export const StateTransitions: Story = {
  render: (args) => <DynamicIslandTransitionDemo onAction={args.onAction} onSecondaryAction={args.onSecondaryAction} />,
};
