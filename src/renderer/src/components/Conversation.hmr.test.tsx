import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal, Show } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConversationController } from "./Conversation";
import { type ConversationProps, isDragLeavingConversation } from "./ConversationView";
import { ConversationControllerProvider } from "./conversation-controller-context";

function controllerProps(onTypingChange = vi.fn()): Pick<ConversationProps, "onTypingChange"> {
  return { onTypingChange };
}

describe("Conversation HMR boundary", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the file drop overlay active while dragging across conversation children", () => {
    const panel = document.createElement("main");
    const child = document.createElement("div");
    const outside = document.createElement("aside");
    panel.append(child);

    expect(isDragLeavingConversation(panel, child)).toBe(false);
    expect(isDragLeavingConversation(panel, outside)).toBe(true);
    expect(isDragLeavingConversation(panel, null)).toBe(true);
  });

  it("keeps user state when the view subtree remounts", async () => {
    let controller: ReturnType<typeof createConversationController> | undefined;

    function Harness() {
      const [viewVisible, setViewVisible] = createSignal(true);
      controller = createConversationController(controllerProps());
      return (
        <ConversationControllerProvider controller={controller}>
          <button type="button" onClick={() => setViewVisible((current) => !current)}>
            Toggle view
          </button>
          <button
            type="button"
            onClick={() => {
              controller?.setDrafts({
                chief: {
                  text: "Preserved draft",
                  attachments: [
                    {
                      id: "attachment-1",
                      name: "context.txt",
                      size: 12,
                      kind: "file",
                      mimeType: "text/plain",
                      previewKind: "text",
                      previewUrl: null,
                    },
                  ],
                  replyToMessageId: "message-1",
                },
              });
              controller?.setEditingDeliveryId("delivery-1");
              controller?.setEditingDraftBackup({ text: "Backup", attachments: [], replyToMessageId: null });
              controller?.setComposerFocusRequest(4);
              controller?.setComposerError("Preserved error");
              controller?.setSubmitting(true);
              controller?.setChatSearchQuery("rollback owner");
              controller?.setChatSearchOpen(true);
              controller?.setChatSearchMessageIds(["message-1"]);
              controller?.setChatSearchTotal(1);
              controller?.setActiveChatSearchIndex(0);
              controller?.setRightPanels({ chief: "settings" });
              controller?.setSettingsPanelWidth(420);
              controller?.setBrowserPanelWidth(520);
              controller?.setBrowserAddress("https://example.com");
              controller?.setOpenReactionMessageId("message-1");
              controller?.setOpenMoreMessageId("message-2");
              controller?.setExpandedEmojiMessageId("message-3");
              controller?.setVoicePhase("recording");
            }}
          >
            Set state
          </button>
          <Show when={viewVisible()}>
            <output aria-label="header state">{controller.rightPanels().chief}</output>
            <output aria-label="timeline state">{controller.chatSearchQuery()}</output>
            <output aria-label="composer state">{controller.drafts().chief?.text}</output>
            <output aria-label="panel state">{controller.settingsPanelWidth()}</output>
            <output aria-label="overlay state">{controller.openReactionMessageId()}</output>
          </Show>
        </ConversationControllerProvider>
      );
    }

    render(() => <Harness />);
    await fireEvent.click(screen.getByRole("button", { name: "Set state" }));
    expect(screen.getByRole("status", { name: "composer state" })).toHaveTextContent("Preserved draft");
    expect(screen.getByRole("status", { name: "timeline state" })).toHaveTextContent("rollback owner");
    expect(screen.getByRole("status", { name: "header state" })).toHaveTextContent("settings");

    await fireEvent.click(screen.getByRole("button", { name: "Toggle view" }));
    expect(screen.queryByRole("status", { name: "composer state" })).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Toggle view" }));

    expect(screen.getByRole("status", { name: "composer state" })).toHaveTextContent("Preserved draft");
    expect(screen.getByRole("status", { name: "timeline state" })).toHaveTextContent("rollback owner");
    expect(screen.getByRole("status", { name: "header state" })).toHaveTextContent("settings");
    expect(screen.getByRole("status", { name: "panel state" })).toHaveTextContent("420");
    expect(screen.getByRole("status", { name: "overlay state" })).toHaveTextContent("message-1");
    expect(controller?.drafts().chief?.attachments).toHaveLength(1);
    expect(controller?.drafts().chief?.replyToMessageId).toBe("message-1");
    expect(controller?.editingDeliveryId()).toBe("delivery-1");
    expect(controller?.editingDraftBackup()?.text).toBe("Backup");
    expect(controller?.composerFocusRequest()).toBe(4);
    expect(controller?.composerError()).toBe("Preserved error");
    expect(controller?.submitting()).toBe(true);
    expect(controller?.chatSearchOpen()).toBe(true);
    expect(controller?.chatSearchMessageIds()).toEqual(["message-1"]);
    expect(controller?.chatSearchTotal()).toBe(1);
    expect(controller?.activeChatSearchIndex()).toBe(0);
    expect(controller?.browserPanelWidth()).toBe(520);
    expect(controller?.browserAddress()).toBe("https://example.com");
    expect(controller?.openMoreMessageId()).toBe("message-2");
    expect(controller?.expandedEmojiMessageId()).toBe("message-3");
    expect(controller?.voicePhase()).toBe("recording");
  });

  it("releases stable typing and voice resources once", () => {
    vi.useFakeTimers();
    const onTypingChange = vi.fn();
    const stopRecorder = vi.fn();
    const stopTrack = vi.fn();

    function Harness() {
      const controller = createConversationController(controllerProps(onTypingChange));
      controller.resources.typingBotId = "chief";
      controller.resources.typingIdleTimer = setTimeout(() => undefined, 60_000);
      controller.resources.voiceRecorder = { state: "recording", stop: stopRecorder };
      controller.resources.voiceStream = { getTracks: () => [{ stop: stopTrack }] };
      controller.resources.voiceRecordingTimer = setTimeout(() => undefined, 60_000);
      controller.resources.voiceElapsedTimer = setInterval(() => undefined, 1_000);
      return <div />;
    }

    const view = render(() => <Harness />);
    view.unmount();

    expect(onTypingChange).toHaveBeenCalledOnce();
    expect(onTypingChange).toHaveBeenCalledWith("chief", false);
    expect(stopRecorder).toHaveBeenCalledOnce();
    expect(stopTrack).toHaveBeenCalledOnce();
    vi.runOnlyPendingTimers();
    expect(onTypingChange).toHaveBeenCalledOnce();
  });
});
