import { createEffect, Show } from "solid-js";
import { ConversationComposer } from "./ConversationComposer";
import { ConversationHeader } from "./ConversationHeader";
import { ConversationOverlays } from "./ConversationOverlays";
import { ConversationPanels } from "./ConversationPanels";
import { ConversationTimeline } from "./ConversationTimeline";
import { ConversationViewScopeContext, createConversationViewScope } from "./conversation-scope";
import type { ConversationProps } from "./conversation-types";
import { MessageSelectionActions } from "./SelectionActions";

/** @internal Keeps file-drag state active while the pointer moves between conversation descendants. */
export function isDragLeavingConversation(currentTarget: HTMLElement, relatedTarget: EventTarget | null): boolean {
  return !(relatedTarget instanceof Node && currentTarget.contains(relatedTarget));
}

export function ConversationView(props: ConversationProps) {
  const scope = createConversationViewScope(props);
  const {
    agentReady,
    browserPanelWidth,
    browserSidebarOpen,
    dropActive,
    filePreviewOpen,
    handleChatSearchShortcut,
    sendSelectionInstruction,
    setConversationPanelElement,
    setDropActive,
    settingsPanelWidth,
    submitting,
  } = scope;
  createEffect(
    () => props.globalOverlayOpen,
    (open) => {
      if (open) setDropActive(false);
    },
  );
  return (
    <ConversationViewScopeContext value={scope}>
      <main
        ref={setConversationPanelElement}
        aria-label="Conversation"
        onKeyDown={handleChatSearchShortcut}
        class={[
          "conversation-panel",
          {
            "conversation-drop-active": dropActive(),
            "browser-panel-active": browserSidebarOpen() || filePreviewOpen(),
          },
        ]}
        style={`--settings-panel-width: ${settingsPanelWidth()}px; --browser-panel-width: ${browserPanelWidth()}px`}
        onDragEnter={(event) => {
          if (!props.globalOverlayOpen && event.dataTransfer?.types.includes("Files")) setDropActive(true);
        }}
        onDragOver={(event) => {
          if (!props.globalOverlayOpen && event.dataTransfer?.types.includes("Files")) event.preventDefault();
        }}
        onDragLeave={(event) => {
          if (isDragLeavingConversation(event.currentTarget, event.relatedTarget)) setDropActive(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDropActive(false);
        }}
      >
        <MessageSelectionActions
          contextKey={props.agent?.id}
          disabled={!props.agent || !agentReady() || submitting()}
          onSend={sendSelectionInstruction}
        />
        <Show when={dropActive()}>
          <div class="attachment-drop-overlay">Drop files to attach</div>
        </Show>
        <ConversationHeader />

        <ConversationTimeline />

        <ConversationComposer />

        <ConversationOverlays />

        <ConversationPanels />
      </main>
    </ConversationViewScopeContext>
  );
}
