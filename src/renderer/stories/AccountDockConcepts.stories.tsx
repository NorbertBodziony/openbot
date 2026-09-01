import type { AccountUsage, BotSummary, ServerSummary, UpdateStatus } from "@openbot/contracts/ipc";
import { Portal } from "@solidjs/web";
import { createEffect, createSignal, onCleanup, onSettled, Show } from "solid-js";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import productionLogoUrl from "../src/assets/openbot-logo-production.png";
import { AccountUpdateIsland } from "../src/components/AccountUpdateIsland";
import { STORY_BOT_SUMMARIES, STORY_SERVERS, STORY_UPDATE_STATUS, STORY_USAGE } from "../src/preview/fixtures";
import { OpenBotPlayground } from "../src/preview/OpenBotPlayground";
import "./AccountDockConcepts.css";

type UpdateIslandState = "none" | "available" | "ready";

const CONCEPT_BOT_NAMES = [
  "Launch planner",
  "Product research",
  "Design critic",
  "Release notes",
  "Customer signals",
  "Market monitor",
  "Frontend builder",
  "Quality review",
  "Support triage",
  "Growth experiments",
  "Data analyst",
  "Meeting briefs",
  "Security review",
  "Documentation",
  "Partner updates",
  "Hiring pipeline",
  "Finance review",
  "Operations",
];

const CONCEPT_SERVER_NAMES = [
  "OpenBot team",
  "Nightly Labs",
  "Product studio",
  "Research room",
  "Launch team",
  "Customer lab",
  "Design systems",
  "Engineering",
  "Market signals",
  "Operations",
  "Community",
  "Experiments",
  "Archive",
  "Sandbox",
];

const CONCEPT_AVATAR_HUES: BotSummary["avatarHue"][] = [150, 185, 215, 245, 280, 320, 0, 30, 55, 100];

const CONCEPT_BOTS: BotSummary[] = [
  ...STORY_BOT_SUMMARIES,
  ...CONCEPT_BOT_NAMES.map((name, index) => {
    const source = STORY_BOT_SUMMARIES[index % STORY_BOT_SUMMARIES.length];
    const id = `dock-concept-bot-${index + 1}`;
    return {
      ...source,
      id,
      name,
      threadId: `thread-${id}`,
      workspacePath: `/mock/OpenBot/Bots/${id}`,
      preview: index % 2 === 0 ? "A new update is ready for review." : "The latest task is in progress.",
      updatedAt: new Date(Date.parse("2026-08-28T10:00:00.000Z") - index * 3_600_000).toISOString(),
      avatarSeed: id,
      avatarHue: CONCEPT_AVATAR_HUES[index % CONCEPT_AVATAR_HUES.length] ?? null,
    };
  }),
];

const localServer = STORY_SERVERS.find((server) => server.kind === "local");
const remoteServer = STORY_SERVERS.find((server) => server.kind === "remote");

const CONCEPT_SERVERS: ServerSummary[] = [
  ...(localServer ? [{ ...localServer, active: true }] : []),
  ...(remoteServer
    ? CONCEPT_SERVER_NAMES.map((name, index) => ({
        ...remoteServer,
        id: `dock-concept-server-${index + 1}`,
        name,
        active: false,
        state: index === CONCEPT_SERVER_NAMES.length - 2 ? ("offline" as const) : ("online" as const),
      }))
    : []),
];

interface AccountDockConceptPlaygroundProps {
  remainingPercent: number;
  updateState: UpdateIslandState;
  previewMotion: boolean;
  onUpdateAction: () => void;
}

const NEUTRAL_UPDATE_STATUS: UpdateStatus = {
  ...STORY_UPDATE_STATUS,
  phase: "idle",
  availableVersion: null,
};

function updateStatusForState(state: UpdateIslandState): UpdateStatus {
  if (state === "none") return NEUTRAL_UPDATE_STATUS;
  return {
    ...STORY_UPDATE_STATUS,
    phase: state,
    progress: state === "ready" ? 100 : null,
  };
}

function StoryUpdateIsland(props: Pick<AccountDockConceptPlaygroundProps, "updateState" | "onUpdateAction">) {
  const [updateStatus, setUpdateStatus] = createSignal(updateStatusForState(props.updateState));
  let progressTimer: number | undefined;
  let completeTimer: number | undefined;

  function clearTimers(): void {
    if (progressTimer !== undefined) window.clearInterval(progressTimer);
    if (completeTimer !== undefined) window.clearTimeout(completeTimer);
    progressTimer = undefined;
    completeTimer = undefined;
  }

  function resetStatus(): void {
    clearTimers();
    setUpdateStatus(updateStatusForState(props.updateState));
  }

  function startDownload(): void {
    setUpdateStatus((current) => ({ ...current, phase: "downloading", progress: 0 }));
    progressTimer = window.setInterval(() => {
      setUpdateStatus((current) => {
        const nextProgress = Math.min((current.progress ?? 0) + 5, 100);
        if (nextProgress === 100) {
          if (progressTimer !== undefined) window.clearInterval(progressTimer);
          progressTimer = undefined;
          completeTimer = window.setTimeout(() => {
            completeTimer = undefined;
            setUpdateStatus((complete) => ({ ...complete, phase: "ready", progress: 100 }));
          }, 500);
        }
        return { ...current, progress: nextProgress };
      });
    }, 240);
  }

  async function handleUpdateAction(): Promise<void> {
    props.onUpdateAction();
    if (updateStatus().phase === "available") startDownload();
  }

  createEffect(
    () => props.updateState,
    () => resetStatus(),
  );
  onCleanup(clearTimers);

  return <AccountUpdateIsland updateStatus={updateStatus()} onUpdateAction={handleUpdateAction} />;
}

function UpdateIslandPortal(props: Pick<AccountDockConceptPlaygroundProps, "updateState" | "onUpdateAction">) {
  const [mount, setMount] = createSignal<HTMLElement | null>(null);

  onSettled(() => {
    const storyRoot = document.querySelector<HTMLElement>(".account-dock-concept");
    if (!storyRoot) return;

    const syncMount = () => {
      const nextMount = storyRoot.querySelector<HTMLElement>(".account-dock.account-dock-hybrid");
      setMount(nextMount);
    };

    syncMount();
    const observer = new MutationObserver(syncMount);
    observer.observe(storyRoot, { childList: true, subtree: true });
    return () => observer.disconnect();
  });

  return (
    <Show when={mount()}>
      {(mountElement) => (
        <Portal mount={mountElement()}>
          <StoryUpdateIsland updateState={props.updateState} onUpdateAction={props.onUpdateAction} />
        </Portal>
      )}
    </Show>
  );
}

function usageWithRemaining(remainingPercent: number): AccountUsage {
  const usedPercent = 100 - remainingPercent;
  return {
    limits: STORY_USAGE.limits.map((limit) => ({
      ...limit,
      secondary: limit.secondary ? { ...limit.secondary, usedPercent } : null,
    })),
  };
}

function AccountDockConceptPlayground(props: AccountDockConceptPlaygroundProps) {
  const [previewUpdateState, setPreviewUpdateState] = createSignal<UpdateIslandState>("none");
  let previewTimer: number | undefined;

  function clearMotionPreview(): void {
    if (previewTimer !== undefined) window.clearTimeout(previewTimer);
    previewTimer = undefined;
  }

  function openMotionPreview(): void {
    setPreviewUpdateState("available");
    previewTimer = window.setTimeout(() => {
      setPreviewUpdateState("none");
      previewTimer = window.setTimeout(openMotionPreview, 900);
    }, 1_800);
  }

  createEffect(
    () => props.previewMotion,
    (previewMotion) => {
      clearMotionPreview();
      setPreviewUpdateState("none");
      if (previewMotion) previewTimer = window.setTimeout(openMotionPreview, 700);
    },
  );

  const storageKey = "openbot:left-panel-collapsed";
  const previous = window.localStorage.getItem(storageKey);
  window.localStorage.setItem(storageKey, "false");
  onCleanup(() => {
    clearMotionPreview();
    if (previous === null) window.localStorage.removeItem(storageKey);
    else window.localStorage.setItem(storageKey, previous);
  });

  const renderedUpdateState = () => (props.previewMotion ? previewUpdateState() : props.updateState);

  return (
    <div class="account-dock-concept">
      <OpenBotPlayground
        options={{
          authState: {
            status: "signed_in",
            user: {
              id: "dock-concept-user",
              email: "norbert.bodziony@nightlylabs.xyz",
              name: "Norbert Bodziony",
              avatarUrl: productionLogoUrl,
            },
          },
          bots: CONCEPT_BOTS,
          servers: CONCEPT_SERVERS,
          usage: usageWithRemaining(props.remainingPercent),
          updateStatus: NEUTRAL_UPDATE_STATUS,
        }}
      />
      <UpdateIslandPortal updateState={renderedUpdateState()} onUpdateAction={props.onUpdateAction} />
    </div>
  );
}

const meta = {
  title: "Explorations/Account dock",
  component: AccountDockConceptPlayground,
  args: {
    remainingPercent: 59,
    updateState: "none",
    previewMotion: false,
    onUpdateAction: fn(),
  },
  argTypes: {
    remainingPercent: {
      control: { type: "range", min: 0, max: 100, step: 1 },
      description: "Weekly usage remaining percentage.",
    },
    updateState: {
      control: "inline-radio",
      options: ["none", "available", "ready"],
      description: "Automatic update island state.",
    },
    previewMotion: {
      control: false,
      table: { disable: true },
    },
    onUpdateAction: {
      control: false,
      description: "Storybook-only update action.",
    },
  },
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "The selected desktop account dock spans both navigation columns and uses the real OpenBot navigation, account popovers, and independent scroll containers.",
      },
    },
  },
} satisfies Meta<typeof AccountDockConceptPlayground>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DiscordShelf: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "Recommended: the compact shelf uses the account identity for secondary actions, with readable weekly usage and direct Settings.",
      },
    },
  },
};

export const WeeklyUsageWarning: Story = {
  args: {
    remainingPercent: 29,
  },
  parameters: {
    docs: {
      description: {
        story: "Warning state: below 30% remaining, the gauge and percentage use the warning color.",
      },
    },
  },
};

export const WeeklyUsageCritical: Story = {
  args: {
    remainingPercent: 9,
  },
  parameters: {
    docs: {
      description: {
        story: "Critical state: below 10% remaining, the gauge and percentage use the danger color.",
      },
    },
  },
};

export const UpdateIsland: Story = {
  args: {
    updateState: "available",
  },
  parameters: {
    docs: {
      description: {
        story:
          "The production update island rises from behind the real account dock without moving the sidebar content.",
      },
    },
  },
};

export const UpdateIslandMotion: Story = {
  args: {
    previewMotion: true,
    updateState: "available",
  },
  parameters: {
    docs: {
      description: {
        story: "The real update island repeatedly opens and closes so both panel-reveal directions can be reviewed.",
      },
    },
  },
};
