import type { JSX } from "@solidjs/web";
import { BatteryFull, Bot, Wifi } from "lucide-solid";
import { type Accessor, createSignal, untrack } from "solid-js";
import type { DynamicIslandStateChangeReason, DynamicIslandViewState } from "../src/components/ui";

export interface DynamicIslandStoryPreviewContext {
  displayMode: "notch" | "island";
  state: Accessor<DynamicIslandViewState>;
  onStateChange: (state: DynamicIslandViewState, reason: DynamicIslandStateChangeReason) => void;
}

interface DynamicIslandDisplayComparisonProps {
  defaultState?: DynamicIslandViewState;
  reducedMotion?: boolean;
  renderIsland: (context: DynamicIslandStoryPreviewContext) => JSX.Element;
}

export function DynamicIslandDisplayComparison(props: DynamicIslandDisplayComparisonProps): JSX.Element {
  const initialState = untrack(() => props.defaultState ?? "compact");
  const [notchState, setNotchState] = createSignal<DynamicIslandViewState>(initialState);
  const [islandState, setIslandState] = createSignal<DynamicIslandViewState>(initialState);

  return (
    <main
      class="dynamic-island-story-stage dynamic-island-story-stage-comparison"
      data-reduced-motion={props.reducedMotion ? "true" : undefined}
    >
      <div class="dynamic-island-story-display-grid">
        <DisplayPreview title="Built-in display" detail="Physical MacBook notch" label="Built-in display preview">
          {props.renderIsland({
            displayMode: "notch",
            state: notchState,
            onStateChange: (next) => setNotchState(next),
          })}
        </DisplayPreview>
        <DisplayPreview title="External display" detail="Floating island" label="External display preview" external>
          {props.renderIsland({
            displayMode: "island",
            state: islandState,
            onStateChange: (next) => setIslandState(next),
          })}
        </DisplayPreview>
      </div>
    </main>
  );
}

function DisplayPreview(props: {
  children: JSX.Element;
  title: string;
  detail: string;
  label: string;
  external?: boolean;
}): JSX.Element {
  return (
    <section
      class={[
        "dynamic-island-story-screen",
        "dynamic-island-story-comparison-screen",
        props.external ? "dynamic-island-story-external-screen" : undefined,
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label={props.label}
    >
      <StoryMenuBar />
      <div class="dynamic-island-story-anchor">{props.children}</div>
      <DisplayLabel title={props.title} detail={props.detail} />
    </section>
  );
}

function DisplayLabel(props: { title: string; detail: string }): JSX.Element {
  return (
    <div class="dynamic-island-story-display-label">
      <strong>{props.title}</strong>
      <span>{props.detail}</span>
    </div>
  );
}

function StoryMenuBar(): JSX.Element {
  return (
    <div class="dynamic-island-story-menubar" aria-hidden="true">
      <span class="dynamic-island-story-menu-left">
        <Bot />
        <strong>OpenBot</strong>
        <span>File</span>
        <span>Edit</span>
        <span>View</span>
      </span>
      <span class="dynamic-island-story-menu-right">
        <Wifi />
        <BatteryFull />
        <span>Fri 10:42</span>
      </span>
    </div>
  );
}
