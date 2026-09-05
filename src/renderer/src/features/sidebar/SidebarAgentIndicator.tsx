import { Show } from "solid-js";
import { AgentAvatar } from "../../components/AgentAvatar";
import { TypingDots } from "../../components/TypingDots";
import type { ResolvedPinnedItem, SidebarAgentState } from "./sidebar-types";

export function SidebarAgentIndicator(props: { state: SidebarAgentState }) {
  const unreadCount = () => (props.state.kind === "unread" ? props.state.count : 0);
  return (
    <span class={`agent-row-agent-status agent-row-agent-status-${props.state.kind}`} aria-hidden="true">
      <Show when={props.state.kind === "working"}>
        <TypingDots class="agent-row-thinking-dots" />
      </Show>
      <Show when={props.state.kind === "responded"}>
        <svg viewBox="0 0 12 12">
          <title>Responded</title>
          <path d="m3 6.2 1.8 1.8L9 3.8" />
        </svg>
      </Show>
      <Show when={props.state.kind === "unread"}>
        <span>{unreadCount()}</span>
      </Show>
    </span>
  );
}

export function SidebarPinnedAvatar(props: {
  item: ResolvedPinnedItem;
  agentState: () => SidebarAgentState | undefined;
}) {
  return (
    <span class="agent-row-avatar sidebar-pinned-avatar">
      {/* A resting agent holds its pose. `"idle"` morphed for as long as the sidebar was on
          screen, which is all day, and bought nothing: the shape is 24 px and nobody is
          looking at it while they work in the pane next to it. `"hover"` brings it back the
          moment a pointer arrives, and real work still animates on its own. */}
      <AgentAvatar agent={props.item.agent} motion={props.agentState()?.kind === "working" ? "working" : "hover"} />
      <Show when={props.agentState()}>{(state) => <SidebarAgentIndicator state={state()} />}</Show>
    </span>
  );
}
