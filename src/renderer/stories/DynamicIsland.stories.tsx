import type {
  DynamicIslandAction,
  DynamicIslandAgentIdentity,
  DynamicIslandPresentation,
  DynamicIslandPromptItem,
} from "@openbot/contracts/ipc";
import type { JSX } from "@solidjs/web";
import { createMemo } from "solid-js";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import type { DynamicIslandViewState } from "../src/components/ui";
import { OpenBotDynamicIsland } from "../src/features/dynamic-island/OpenBotDynamicIsland";
import { DynamicIslandDisplayComparison } from "./DynamicIslandDisplayComparison";
import { STORY_AGENTS } from "./fixtures";

type Scenario = "idle" | "working" | "chat" | "question" | "approval" | "takeover" | "failed";
type QuestionVariant = "standard" | "short" | "long" | "multiple";
type WorkingVariant = "single" | "multiple";

interface DynamicIslandDemoProps {
  scenario: Scenario;
  questionVariant?: QuestionVariant;
  workingVariant?: WorkingVariant;
  defaultState?: DynamicIslandViewState;
  onAction: (action: DynamicIslandAction) => void;
}

const AGENT_IDENTITIES = STORY_AGENTS.slice(0, 3).map(toIslandAgent);
const SCENARIOS: Scenario[] = ["idle", "working", "chat", "question", "approval", "takeover", "failed"];

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
  if (scenario === "working") {
    const working = [
      { agent: AGENT_IDENTITIES[0], task: "Planning the launch sequence" },
      { agent: AGENT_IDENTITIES[1], task: "Checking primary sources" },
      { agent: AGENT_IDENTITIES[2], task: "Drafting partner follow-ups" },
    ];
    return {
      serverId: "local",
      mode: "working",
      working: workingVariant === "single" ? working.slice(0, 1) : working,
    };
  }
  if (scenario === "chat") {
    return {
      serverId: "local",
      mode: "message",
      unreadCount: 2,
      message: {
        agent: AGENT_IDENTITIES[1],
        messageId: "research-reply",
        text: "I found three reliable sources. The market data supports the main claim.",
        createdAt: "2026-08-28T10:42:00.000Z",
      },
    };
  }
  if (scenario === "question") {
    return { serverId: "local", mode: "question", remainingCount: 0, item: questionFixture(questionVariant) };
  }
  if (scenario === "approval") {
    return {
      serverId: "local",
      mode: "approval",
      remainingCount: 0,
      item: {
        requestId: "chief-command-approval",
        agent: AGENT_IDENTITIES[0],
        title: "Command needs review",
        detail: "Chief needs to install the verified workspace dependencies before tests can run.",
        truncated: false,
        approval: {
          kind: "command",
          command: "bun install --frozen-lockfile",
          cwd: "~/Projects/openbot",
          reason: "Install the locked dependencies before running the test suite.",
          grantRoot: null,
          permissions: null,
        },
      },
    };
  }
  if (scenario === "takeover") {
    return {
      serverId: "local",
      mode: "takeover",
      item: {
        requestId: "chief-browser-takeover",
        agent: AGENT_IDENTITIES[0],
        title: "Browser step needs you",
        detail: "Complete the sign-in, verification, or consent in the browser.",
      },
    };
  }
  if (scenario === "failed") {
    return {
      serverId: "local",
      mode: "failed",
      item: {
        turnId: "research-failed-turn",
        agent: AGENT_IDENTITIES[1],
        title: "Task failed",
        detail: "The browser tab closed before Research could finish collecting the sources.",
      },
    };
  }
  return { serverId: "local", mode: "idle" };
}

function questionFixture(variant: QuestionVariant): DynamicIslandPromptItem {
  if (variant === "short") {
    const options = [
      { label: "Send it", description: "Use this draft" },
      { label: "Revise", description: "Make one more pass" },
    ];
    return {
      requestId: "siema-tone-question",
      agent: { ...AGENT_IDENTITIES[1], id: "siema", name: "Siema", avatarSeed: "siema" },
      title: "Send this version?",
      detail: "The draft is ready.",
      questions: [
        {
          id: "send-version",
          header: "Send this version?",
          question: "The draft is ready. Which version should I use?",
          isSecret: false,
          options,
        },
      ],
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
      requestId: "international-market-research-source-question",
      agent: {
        ...AGENT_IDENTITIES[1],
        id: "international-market-research",
        name: "International Market Research, Competitive Intelligence, and Strategic Operations",
        avatarSeed: "international-market-research",
      },
      title: "Choose the primary evidence source for the international market-size estimate.",
      detail:
        "Which source should I cite when the available datasets use different regional definitions and reporting periods?",
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
    };
  }

  if (variant === "multiple") {
    const sourceOptions = [
      { label: "Official data", description: "Use the latest government dataset" },
      { label: "Industry report", description: "Use the detailed paid report" },
      { label: "Use both", description: "Compare both sources and explain the difference" },
    ];
    return {
      requestId: "research-multiple-question",
      agent: AGENT_IDENTITIES[1],
      title: "Choose a source",
      detail: "Which source should I use for the market-size estimate?",
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
    };
  }

  const options = [
    { label: "Official data", description: "Use the latest government dataset" },
    { label: "Industry report", description: "Use the detailed paid report" },
    { label: "Use both", description: "Compare both sources and explain the difference" },
  ];
  return {
    requestId: "research-source-question",
    agent: AGENT_IDENTITIES[1],
    title: "Choose a source",
    detail: "Which source should I use for the market-size estimate?",
    questions: [
      {
        id: "source",
        header: "Choose a source",
        question: "Which source should I use for the market-size estimate?",
        isSecret: false,
        options,
      },
    ],
  };
}

function toIslandAgent(agent: (typeof STORY_AGENTS)[number]): DynamicIslandAgentIdentity {
  return {
    id: agent.id,
    name: agent.name,
    avatarSeed: agent.avatarSeed,
    avatarHue: agent.avatarHue,
    avatarUrl: agent.avatarUrl,
  };
}

const meta = {
  title: "Experiments/macOS Dynamic Island",
  component: DynamicIslandDemo,
  args: { scenario: "working", defaultState: "compact", onAction: fn() },
  argTypes: {
    scenario: { control: "select", options: SCENARIOS },
    questionVariant: { control: "select", options: ["standard", "short", "long", "multiple"] },
    workingVariant: { control: "select", options: ["single", "multiple"] },
    defaultState: { control: "select", options: ["compact", "expanded"] },
  },
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta<typeof DynamicIslandDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};
