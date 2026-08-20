import { ProviderLogo, type ProviderLogoVariant } from "@openbot/brand";
import { createEffect, createSignal, For, Match, onCleanup, onSettled, Show, Switch } from "solid-js";
import { LandingIcon } from "./LandingIcon";

type DemoAgentId = "chief" | "release" | "research";
type DemoAgentStatus = "Responded" | "Working";
type DemoInspectorKind = "browser" | "context" | "workspace";
type DemoMessageAuthor = "agent" | "system" | "you";

interface DemoMessage {
  attachment?: {
    meta: string;
    name: string;
  };
  author: DemoMessageAuthor;
  id: string;
  meta?: string;
  text: string;
}

interface DemoQueueItem {
  label: string;
  state: "queued" | "running";
}

interface DemoAgent {
  id: DemoAgentId;
  inspector: DemoInspectorKind;
  messages: DemoMessage[];
  model: string;
  name: string;
  preview: string;
  provider: ProviderLogoVariant;
  queue: DemoQueueItem[];
  role: string;
  status: DemoAgentStatus;
  workspace: string;
}

const AUTOPLAY_DELAY_MS = 3_800;
const AUTOPLAY_ORDER: readonly DemoAgentId[] = ["chief", "research", "release"];

const DEMO_AGENTS: readonly DemoAgent[] = [
  {
    id: "chief",
    name: "Chief",
    role: "Chief of staff",
    provider: "codex",
    model: "Luna",
    status: "Working",
    preview: "Handed the source check to Research.",
    workspace: "~/OpenBot/Bots/chief",
    inspector: "workspace",
    queue: [],
    messages: [
      {
        id: "chief-user",
        author: "you",
        text: "Turn the launch notes into a rollout plan and ask Research to verify the sources.",
      },
      {
        id: "chief-agent",
        author: "agent",
        text: "I drafted the plan in my workspace and sent the source check to Research. I’ll merge the result when it comes back.",
      },
      {
        id: "chief-handoff",
        author: "system",
        text: "Messaged Research",
        meta: "Queued",
      },
    ],
  },
  {
    id: "research",
    name: "Research",
    role: "Research partner",
    provider: "claude",
    model: "Sonnet",
    status: "Responded",
    preview: "Three sources are ready for review.",
    workspace: "~/OpenBot/Bots/research",
    inspector: "context",
    queue: [],
    messages: [
      {
        id: "research-handoff",
        author: "system",
        text: "Request from Chief",
        meta: "Workspace handoff",
      },
      {
        id: "research-agent",
        author: "agent",
        text: "I checked the launch claims against primary sources. Two are ready; one needs a version note.",
        attachment: {
          name: "source-check.md",
          meta: "3 sources · 8 KB",
        },
      },
    ],
  },
  {
    id: "release",
    name: "Release",
    role: "Release operator",
    provider: "codex",
    model: "Terra",
    status: "Working",
    preview: "Windows verification is running.",
    workspace: "~/OpenBot/Bots/release",
    inspector: "browser",
    queue: [
      { label: "Verify Windows package", state: "running" },
      { label: "Generate release checksums", state: "queued" },
      { label: "Draft release notes", state: "queued" },
    ],
    messages: [
      {
        id: "release-user",
        author: "you",
        text: "Prepare the desktop release and verify both installers.",
      },
      {
        id: "release-agent",
        author: "agent",
        text: "The macOS build is ready. Windows verification is running, and checksums are next in the queue.",
      },
    ],
  },
] as const;

function DemoAgentButton(props: { active: boolean; agent: DemoAgent; onSelect: (id: DemoAgentId) => void }) {
  return (
    <button
      class="landing-demo-agent"
      type="button"
      aria-pressed={props.active ? "true" : "false"}
      data-agent={props.agent.id}
      data-model={props.agent.model}
      data-workspace={props.agent.workspace}
      onClick={() => props.onSelect(props.agent.id)}
    >
      <span class="landing-demo-agent-mark">
        <ProviderLogo provider={props.agent.provider} />
      </span>
      <span class="landing-demo-agent-copy">
        <span class="landing-demo-agent-heading">
          <strong>{props.agent.name}</strong>
          <small>{props.agent.status}</small>
        </span>
        <span class="landing-demo-agent-role">{props.agent.role}</span>
        <span class="landing-demo-agent-preview">{props.agent.preview}</span>
      </span>
    </button>
  );
}

function DemoMessages(props: { agent: DemoAgent }) {
  return (
    <div class="landing-demo-messages" data-demo-panel={props.agent.id}>
      <For each={props.agent.messages}>
        {(message) => (
          <Show
            when={message.author !== "system"}
            fallback={
              <div class="landing-demo-event">
                <span class="landing-demo-event-icon">
                  <LandingIcon name="handoff" />
                </span>
                <span>{message.text}</span>
                <small>{message.meta}</small>
              </div>
            }
          >
            <article class="landing-demo-message" data-author={message.author}>
              <p>{message.text}</p>
              <Show when={message.attachment}>
                {(attachment) => (
                  <div class="landing-demo-attachment">
                    <span class="landing-demo-file-icon">
                      <LandingIcon name="file" />
                    </span>
                    <span>
                      <strong>{attachment().name}</strong>
                      <small>{attachment().meta}</small>
                    </span>
                  </div>
                )}
              </Show>
            </article>
          </Show>
        )}
      </For>
    </div>
  );
}

function DemoQueue(props: { items: readonly DemoQueueItem[] }) {
  return (
    <Show when={props.items.length > 0}>
      <section class="landing-demo-queue" aria-label="Release queue">
        <header>
          <span>Queue</span>
          <small>{props.items.length} tasks</small>
        </header>
        <For each={props.items}>
          {(item, index) => (
            <div class="landing-demo-queue-item" data-state={item.state}>
              <span class="landing-demo-queue-position">{index() + 1}</span>
              <span>{item.label}</span>
              <small>{item.state === "running" ? "Running" : "Queued"}</small>
            </div>
          )}
        </For>
      </section>
    </Show>
  );
}

function DemoInspector(props: { agent: DemoAgent; hidden?: boolean }) {
  return (
    <aside
      class="landing-demo-inspector"
      aria-label={`${props.agent.name} agent details`}
      data-demo-panel={props.agent.id}
      hidden={props.hidden}
    >
      <Switch>
        <Match when={props.agent.inspector === "workspace"}>
          <header class="landing-demo-inspector-heading">
            <span class="landing-demo-inspector-icon">
              <LandingIcon name="workspace" />
            </span>
            <span>
              <small>Workspace</small>
              <strong>Chief</strong>
            </span>
          </header>
          <p class="landing-demo-path">{props.agent.workspace}</p>
          <div class="landing-demo-files">
            <For each={["launch-plan.md", "AGENTS.md", "release-notes.md"]}>
              {(file) => (
                <div>
                  <LandingIcon name="file" />
                  <span>{file}</span>
                </div>
              )}
            </For>
          </div>
        </Match>

        <Match when={props.agent.inspector === "context"}>
          <header class="landing-demo-inspector-heading">
            <span class="landing-demo-inspector-icon">
              <LandingIcon name="context" />
            </span>
            <span>
              <small>Persistent context</small>
              <strong>Research</strong>
            </span>
          </header>
          <div
            class="landing-demo-context-meter"
            role="progressbar"
            aria-label="Context used"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow="64"
          >
            <span style={{ width: "64%" }} />
          </div>
          <div class="landing-demo-context-copy">
            <span>64% context used</span>
            <small>Auto-compaction ready</small>
          </div>
          <div class="landing-demo-context-note">
            <LandingIcon name="check" />
            <span>Source preferences remembered</span>
          </div>
        </Match>

        <Match when={props.agent.inspector === "browser"}>
          <header class="landing-demo-inspector-heading">
            <span class="landing-demo-inspector-icon">
              <LandingIcon name="browser" />
            </span>
            <span>
              <small>Embedded browser</small>
              <strong>Releases</strong>
            </span>
          </header>
          <div class="landing-demo-browser">
            <div class="landing-demo-browser-bar">
              <LandingIcon name="browser" />
              <span>github.com/NorbertBodziony/openbot/releases</span>
            </div>
            <div class="landing-demo-browser-page">
              <strong>Release checks</strong>
              <ul>
                <li data-state="done">
                  <LandingIcon name="check" /> macOS build ready
                </li>
                <li data-state="running">
                  <span /> Windows verification running
                </li>
                <li data-state="queued">
                  <span /> Checksums queued
                </li>
              </ul>
            </div>
          </div>
        </Match>
      </Switch>
    </aside>
  );
}

export function ProductDemo() {
  const [activeAgentId, setActiveAgentId] = createSignal<DemoAgentId>("chief");
  const [inViewport, setInViewport] = createSignal(false);
  const [pageVisible, setPageVisible] = createSignal(false);
  const [reducedMotion, setReducedMotion] = createSignal(true);
  const [userControlled, setUserControlled] = createSignal(false);
  let root: HTMLElement | undefined;
  let autoplayTimer: ReturnType<typeof setTimeout> | undefined;

  const activeAgent = () => DEMO_AGENTS.find((agent) => agent.id === activeAgentId()) ?? DEMO_AGENTS[0];

  function selectAgent(id: DemoAgentId): void {
    setUserControlled(true);
    setActiveAgentId(id);
  }

  createEffect(
    () => ({
      activeAgentId: activeAgentId(),
      inViewport: inViewport(),
      pageVisible: pageVisible(),
      reducedMotion: reducedMotion(),
      userControlled: userControlled(),
    }),
    (state) => {
      if (autoplayTimer) clearTimeout(autoplayTimer);
      autoplayTimer = undefined;
      if (state.userControlled || state.reducedMotion || !state.inViewport || !state.pageVisible) return;

      const currentIndex = AUTOPLAY_ORDER.indexOf(state.activeAgentId);
      const nextAgent = AUTOPLAY_ORDER[currentIndex + 1];
      if (!nextAgent) return;
      autoplayTimer = setTimeout(() => setActiveAgentId(nextAgent), AUTOPLAY_DELAY_MS);
    },
  );

  onCleanup(() => {
    if (autoplayTimer) clearTimeout(autoplayTimer);
  });

  onSettled(() => {
    const element = root;
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const handleMotionChange = () => setReducedMotion(Boolean(media?.matches));
    const handleVisibilityChange = () => setPageVisible(!document.hidden);
    handleMotionChange();
    handleVisibilityChange();

    const observer = globalThis.IntersectionObserver
      ? new IntersectionObserver(
          (entries) => setInViewport(entries.some((entry) => entry.isIntersecting && entry.intersectionRatio >= 0.45)),
          { threshold: [0.45] },
        )
      : undefined;
    if (element && observer) observer.observe(element);
    else setInViewport(true);

    media?.addEventListener?.("change", handleMotionChange);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      observer?.disconnect();
      media?.removeEventListener?.("change", handleMotionChange);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  });

  return (
    <section
      ref={root}
      class="landing-preview landing-product-demo"
      aria-labelledby="product-demo-title"
      data-demo-agent={activeAgentId()}
      data-demo-user-controlled={userControlled() ? "true" : "false"}
      data-enter="preview"
    >
      <h2 id="product-demo-title" class="landing-visually-hidden">
        OpenBot interactive product demo
      </h2>
      <div class="landing-preview-titlebar" aria-hidden="true">
        <span class="landing-window-controls">
          <span />
          <span />
          <span />
        </span>
        <span class="landing-preview-name">OpenBot</span>
        <span class="landing-preview-state">Live demo</span>
      </div>

      <div class="landing-demo-shell">
        <aside class="landing-demo-sidebar" aria-label="Demo agents">
          <div class="landing-demo-sidebar-heading">
            <strong>Local</strong>
            <span aria-hidden="true">
              <LandingIcon name="plus" />
            </span>
          </div>
          <div class="landing-demo-search" aria-hidden="true">
            <LandingIcon name="search" />
            <span>Search agents</span>
          </div>
          <p class="landing-demo-section-label">Agents</p>
          <div class="landing-demo-agent-list">
            <For each={DEMO_AGENTS}>
              {(agent) => (
                <DemoAgentButton active={activeAgentId() === agent.id} agent={agent} onSelect={selectAgent} />
              )}
            </For>
          </div>
          <div class="landing-demo-profile">
            <span>NB</span>
            <strong>Norbert</strong>
          </div>
        </aside>

        <nav class="landing-demo-mobile-agents" aria-label="Demo agents">
          <For each={DEMO_AGENTS}>
            {(agent) => <DemoAgentButton active={activeAgentId() === agent.id} agent={agent} onSelect={selectAgent} />}
          </For>
        </nav>

        <section class="landing-demo-conversation" aria-label="Agent conversation">
          <header class="landing-demo-conversation-heading">
            <span class="landing-demo-conversation-agent">
              <span class="landing-demo-agent-mark">
                <ProviderLogo provider={activeAgent().provider} />
              </span>
              <span>
                <strong>{activeAgent().name}</strong>
                <small>{activeAgent().role}</small>
              </span>
            </span>
            <span class="landing-demo-model">
              <ProviderLogo provider={activeAgent().provider} />
              {activeAgent().provider === "codex" ? "Codex" : "Claude"} · {activeAgent().model}
            </span>
          </header>

          <For each={DEMO_AGENTS}>
            {(agent) => (
              <section
                class="landing-demo-agent-content"
                data-demo-content={agent.id}
                hidden={activeAgentId() !== agent.id}
              >
                <DemoMessages agent={agent} />
                <DemoQueue items={agent.queue} />
              </section>
            )}
          </For>

          <fieldset class="landing-demo-composer" disabled>
            <legend class="landing-visually-hidden">Demo message composer</legend>
            <span class="landing-demo-composer-add" aria-hidden="true">
              <LandingIcon name="plus" />
            </span>
            <input type="text" placeholder="Download OpenBot to send messages" disabled />
            <button type="button" disabled aria-label="Send message unavailable in demo">
              <LandingIcon name="send" />
            </button>
          </fieldset>
        </section>

        <For each={DEMO_AGENTS}>{(agent) => <DemoInspector agent={agent} hidden={activeAgentId() !== agent.id} />}</For>
      </div>
    </section>
  );
}
