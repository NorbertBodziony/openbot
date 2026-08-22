import type { JSX } from "@solidjs/web";
import { createSignal, For, onCleanup, onSettled, Show } from "solid-js";
import { Button } from "../components/ui/button";
import type { LandingPreviewPeopleProps } from "./LandingPreviewPeople";
import "./landing-preview.css";

export const LANDING_PREVIEW_READY_MESSAGE = "openbot:landing-preview-ready";
export const LANDING_PREVIEW_START_MESSAGE = "openbot:landing-preview-start";

const LANDING_PREVIEW_READY_RETRY_MS = 250;
const LANDING_PREVIEW_PEOPLE_IDLE_MS = 5_000;

type AgentId = "chief" | "research" | "builder" | "launch";
type RunPhase = "resting" | "prompt" | "thinking" | "answer";
type PeopleComponent = (props: LandingPreviewPeopleProps) => JSX.Element;

interface LandingAgent {
  id: AgentId;
  name: string;
  title: string;
  preview: string;
  hue: string;
  prompt: string;
  thinking: string;
  answer: string;
}

const LANDING_AGENTS: LandingAgent[] = [
  {
    id: "chief",
    name: "Chief",
    title: "Chief of staff",
    preview: "The final review is ready.",
    hue: "var(--openbot-preview-agent-chief)",
    prompt: "Turn this into the final launch brief and keep every decision traceable.",
    thinking: "Checking Research's evidence and Builder's rollout notes.",
    answer:
      "The final launch brief is ready. Seven of eight claims are verified, rollback has an owner, and Launch has the complete handoff.",
  },
  {
    id: "research",
    name: "Research",
    title: "Research partner",
    preview: "Seven of eight claims verified.",
    hue: "var(--openbot-preview-agent-research)",
    prompt: "Verify the claims in the launch brief and flag anything without a source.",
    thinking: "Mapping each claim to the source files.",
    answer:
      "Seven claims are verified. The review-time claim still needs a primary source, so I marked it for removal.",
  },
  {
    id: "builder",
    name: "Builder",
    title: "Product engineer",
    preview: "The rollback path is tested.",
    hue: "var(--openbot-preview-agent-builder)",
    prompt: "Turn Research's findings into a release checklist with rollback steps.",
    thinking: "Checking the release gates and rollback command.",
    answer:
      "The rollout checklist is ready. Product QA passed, the rollback path is tested, and the remaining claim has an owner.",
  },
  {
    id: "launch",
    name: "Launch",
    title: "Go-to-market lead",
    preview: "The release package is ready.",
    hue: "var(--openbot-preview-agent-launch)",
    prompt: "Package the final release note and hand it back to Chief.",
    thinking: "Combining the approved copy with the rollout checklist.",
    answer: "The final release note is ready. It includes the evidence note, source links, and tested rollback steps.",
  },
];

const LANDING_PEOPLE = [
  { id: "member-alice", name: "Alice", initials: "AL", color: "var(--openbot-preview-person-alice)", unread: 1 },
  { id: "member-maya", name: "Maya", initials: "MA", color: "var(--openbot-preview-person-maya)", unread: 0 },
  { id: "member-jon", name: "Jon", initials: "JO", color: "var(--openbot-preview-person-jon)", unread: 0 },
] as const;

export interface LandingPreviewAppDependencies {
  loadPeople?: () => Promise<{ LandingPreviewPeople: PeopleComponent }>;
}

export interface LandingPreviewAppProps {
  dependencies?: LandingPreviewAppDependencies;
}

function agentById(id: AgentId): LandingAgent {
  return LANDING_AGENTS.find((agent) => agent.id === id) ?? LANDING_AGENTS[0];
}

export function LandingPreviewApp(props: LandingPreviewAppProps = {}) {
  const loadPeopleModule =
    props.dependencies?.loadPeople ??
    (() => import("./LandingPreviewPeople").then((module) => ({ LandingPreviewPeople: module.LandingPreviewPeople })));
  const [activeAgentId, setActiveAgentId] = createSignal<AgentId>("chief");
  const [selectedPersonId, setSelectedPersonId] = createSignal<string | null>(null);
  const [runPhase, setRunPhase] = createSignal<RunPhase>("resting");
  const [peopleComponent, setPeopleComponent] = createSignal<PeopleComponent>();
  const [peopleLoadFailed, setPeopleLoadFailed] = createSignal(false);
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let peoplePromise: Promise<void> | undefined;
  let activated = false;

  const activeAgent = () => agentById(activeAgentId());

  function schedule(callback: () => void, delay: number): void {
    const timer = setTimeout(() => {
      timers.delete(timer);
      callback();
    }, delay);
    timers.add(timer);
  }

  function clearScriptTimers(): void {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  }

  function runAgentScript(): void {
    clearScriptTimers();
    setRunPhase("resting");
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (reducedMotion) {
      setRunPhase("answer");
      return;
    }
    schedule(() => setRunPhase("prompt"), 250);
    schedule(() => setRunPhase("thinking"), 450);
    schedule(() => setRunPhase("answer"), 1_250);
  }

  function selectAgent(id: AgentId): void {
    setSelectedPersonId(null);
    if (activeAgentId() === id) return;
    setActiveAgentId(id);
    if (activated) runAgentScript();
  }

  function preloadPeople(): Promise<void> {
    if (peoplePromise) return peoplePromise;
    peoplePromise = loadPeopleModule()
      .then((module) => {
        setPeopleComponent(() => module.LandingPreviewPeople);
      })
      .catch(() => {
        setPeopleLoadFailed(true);
      });
    return peoplePromise;
  }

  function selectPerson(id: string): void {
    clearScriptTimers();
    setSelectedPersonId(id);
    void preloadPeople();
  }

  onSettled(() => {
    if (window.parent === window) return;
    const parent = window.parent;
    const origin = window.location.origin;
    let firstPaintFrame: number | undefined;
    let stablePaintFrame: number | undefined;
    let readyTimer: ReturnType<typeof setInterval> | undefined;
    let peopleIdleTimer: ReturnType<typeof setTimeout> | undefined;

    const reportReady = () => {
      parent.postMessage({ type: LANDING_PREVIEW_READY_MESSAGE }, origin);
    };
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== parent) return;
      if (event.data?.type !== LANDING_PREVIEW_START_MESSAGE || activated) return;
      activated = true;
      if (readyTimer) clearInterval(readyTimer);
      window.performance.mark?.("openbot:landing-preview:interactive");
      runAgentScript();
      peopleIdleTimer = setTimeout(() => void preloadPeople(), LANDING_PREVIEW_PEOPLE_IDLE_MS);
    };

    window.addEventListener("message", handleMessage);
    firstPaintFrame = window.requestAnimationFrame(() => {
      stablePaintFrame = window.requestAnimationFrame(() => {
        reportReady();
        readyTimer = setInterval(reportReady, LANDING_PREVIEW_READY_RETRY_MS);
      });
    });

    return () => {
      if (firstPaintFrame !== undefined) window.cancelAnimationFrame(firstPaintFrame);
      if (stablePaintFrame !== undefined) window.cancelAnimationFrame(stablePaintFrame);
      if (readyTimer) clearInterval(readyTimer);
      if (peopleIdleTimer) clearTimeout(peopleIdleTimer);
      window.removeEventListener("message", handleMessage);
    };
  });

  onCleanup(clearScriptTimers);

  return (
    <div class="landing-demo" data-testid="landing-preview-app">
      <aside class="landing-demo-servers" aria-label="Servers">
        <Button type="button" class="landing-demo-server landing-demo-server-local" aria-label="Local server">
          <span class="landing-demo-server-eyes" aria-hidden="true" />
        </Button>
        <Button
          type="button"
          class="landing-demo-server landing-demo-server-active"
          aria-label="OpenBot team server"
          aria-current="page"
        >
          <span class="landing-demo-server-eyes" aria-hidden="true" />
        </Button>
        <span class="landing-demo-server-add" aria-hidden="true">
          +
        </span>
      </aside>

      <aside class="landing-demo-sidebar" aria-label="OpenBot team navigation">
        <header class="landing-demo-sidebar-header">
          <strong>OpenBot team</strong>
          <span aria-hidden="true">◫　＋</span>
        </header>
        <div class="landing-demo-search" aria-hidden="true">
          <span>⌕</span> Search
        </div>
        <nav class="landing-demo-navigation" aria-label="Chats">
          <section class="landing-demo-group" aria-labelledby="landing-demo-agents-heading">
            <h2 id="landing-demo-agents-heading">Agents</h2>
            <For each={LANDING_AGENTS}>
              {(agent) => (
                <Button
                  type="button"
                  class={`landing-demo-chat-row${selectedPersonId() === null && activeAgentId() === agent.id ? " is-active" : ""}`}
                  onClick={() => selectAgent(agent.id)}
                  aria-pressed={selectedPersonId() === null && activeAgentId() === agent.id ? "true" : "false"}
                  aria-label={agent.name}
                >
                  <span class="landing-demo-agent-avatar" style={{ "--agent-hue": agent.hue }} aria-hidden="true">
                    <i />
                    <i />
                  </span>
                  <span class="landing-demo-chat-copy">
                    <strong>{agent.name}</strong>
                    <small>{agent.preview}</small>
                  </span>
                </Button>
              )}
            </For>
          </section>

          <section
            class="landing-demo-group landing-demo-people-group"
            aria-labelledby="landing-demo-people-heading"
            onPointerEnter={() => void preloadPeople()}
            onFocusIn={() => void preloadPeople()}
          >
            <h2 id="landing-demo-people-heading">People</h2>
            <For each={LANDING_PEOPLE}>
              {(person) => (
                <Button
                  type="button"
                  class={`landing-demo-chat-row${selectedPersonId() === person.id ? " is-active" : ""}`}
                  onClick={() => selectPerson(person.id)}
                  aria-pressed={selectedPersonId() === person.id ? "true" : "false"}
                  aria-label={person.name}
                >
                  <span class="landing-demo-person-avatar" style={{ "--person-hue": person.color }} aria-hidden="true">
                    {person.initials}
                  </span>
                  <span class="landing-demo-chat-copy">
                    <strong>{person.name}</strong>
                    <small>{person.unread ? "Final wording is ready." : "Online"}</small>
                  </span>
                  <Show when={person.unread}>
                    <span class="landing-demo-unread" role="status" aria-label={`${person.unread} unread message`}>
                      {person.unread}
                    </span>
                  </Show>
                </Button>
              )}
            </For>
          </section>
        </nav>
        <footer class="landing-demo-account">
          <span class="landing-demo-account-avatar" aria-hidden="true">
            N
          </span>
          <span>
            <strong>Norbert</strong>
            <small>person@example.com</small>
          </span>
          <span aria-hidden="true">•••</span>
        </footer>
      </aside>

      <Show
        when={selectedPersonId() === null}
        fallback={
          <Show
            when={peopleComponent()}
            keyed
            fallback={
              <main class="landing-demo-conversation landing-demo-conversation-loading" aria-live="polite">
                <span class="landing-demo-loading-dot" />
                <p>{peopleLoadFailed() ? "Could not load this conversation." : "Loading conversation…"}</p>
              </main>
            }
          >
            {(People) => <People selectedPersonId={selectedPersonId() ?? LANDING_PEOPLE[0].id} />}
          </Show>
        }
      >
        <main class="landing-demo-conversation" aria-label={`${activeAgent().name} conversation`}>
          <header class="landing-demo-conversation-header">
            <span
              class="landing-demo-agent-avatar landing-demo-agent-avatar-small"
              style={{ "--agent-hue": activeAgent().hue }}
              aria-hidden="true"
            >
              <i />
              <i />
            </span>
            <strong>{activeAgent().name}</strong>
            <span class="landing-demo-model">◉　Luna　⌄</span>
            <span class="landing-demo-header-icons" aria-hidden="true">
              ⌁　▣
            </span>
          </header>
          <div class="landing-demo-messages" aria-live="polite">
            <article class="landing-demo-message landing-demo-message-user">
              Prepare the launch plan, tag Research, and keep every decision traceable.
            </article>
            <article class="landing-demo-message landing-demo-message-assistant">
              <strong>Launch plan</strong>
              <p>Research verified the evidence. Builder checked the rollout path and rollback owner.</p>
              <div class="landing-demo-file-row">
                <span>▤</span>
                <span>
                  launch-metrics.csv
                  <small>1 KB</small>
                </span>
              </div>
              <span class="landing-demo-reaction">✅</span>
            </article>
            <p class="landing-demo-handoff">
              Messaged　<span>●</span>
              <span>●</span>　2 agents　11:44
            </p>
            <article class="landing-demo-message landing-demo-message-assistant">
              {activeAgent().preview} The launch package has clear owners and a tested rollback path.
            </article>
            <Show when={runPhase() !== "resting"}>
              <article class="landing-demo-message landing-demo-message-user">{activeAgent().prompt}</article>
            </Show>
            <Show when={runPhase() === "thinking"}>
              <p class="landing-demo-thinking">
                <span>•••</span> {activeAgent().thinking}
              </p>
            </Show>
            <Show when={runPhase() === "answer"}>
              <article class="landing-demo-message landing-demo-message-assistant landing-demo-message-new">
                {activeAgent().answer}
              </article>
            </Show>
          </div>
          <footer class="landing-demo-composer" aria-hidden="true">
            <span>Message {activeAgent().name}</span>
            <span>＋　◉</span>
          </footer>
        </main>
      </Show>
    </div>
  );
}
