import type {
  AgentEvent,
  BotMemory,
  CreateBotMemoryInput,
  DeleteBotMemoryInput,
  UpdateBotMemoryInput,
} from "@openbot/contracts/ipc";
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AnalyticsEventName, type DesktopAnalyticsEvents, desktopAnalytics } from "../../analytics";
import { createMockOpenBot, type MockOpenBotControls } from "../../preview/mock-openbot";
import { AgentMemoriesModal } from "./AgentMemoriesModal";

const firstMemory: BotMemory = {
  id: "memory-1",
  botId: "chief",
  text: "Uses metric units.",
  origin: "automatic",
  sourceTurnId: "turn-1",
  createdAt: "2026-08-24T12:00:00.000Z",
  updatedAt: "2026-08-24T12:00:00.000Z",
};

let memoryState: BotMemory[];
let emitAgentEvent: ((event: AgentEvent) => void) | undefined;
let listMemories: Mock<(botId: string) => Promise<BotMemory[]>>;
let createMemory: Mock<(input: CreateBotMemoryInput) => Promise<BotMemory>>;
let updateMemory: Mock<(input: UpdateBotMemoryInput) => Promise<BotMemory>>;
let deleteMemory: Mock<(input: DeleteBotMemoryInput) => Promise<void>>;
let clearMemories: Mock<(botId: string) => Promise<void>>;
let activeMock: MockOpenBotControls | undefined;
const trackMemoryAnalytics = vi.fn();

function trackScopedMemoryAnalytics<Name extends AnalyticsEventName>(
  name: Name,
  properties: DesktopAnalyticsEvents[Name],
) {
  trackMemoryAnalytics(name, properties);
}

vi.spyOn(desktopAnalytics, "scope").mockImplementation(() => ({ track: trackScopedMemoryAnalytics }));

afterEach(() => {
  activeMock?.dispose();
  activeMock = undefined;
});

beforeEach(() => {
  trackMemoryAnalytics.mockClear();
  memoryState = [];
  emitAgentEvent = undefined;
  listMemories = vi.fn(async () => [...memoryState]);
  createMemory = vi.fn(async (input: { botId: string; text: string }) => {
    const memory: BotMemory = {
      ...firstMemory,
      id: "memory-new",
      botId: input.botId,
      text: input.text,
      origin: "manual",
      sourceTurnId: null,
    };
    memoryState.push(memory);
    return memory;
  });
  updateMemory = vi.fn(async (input: { botId: string; memoryId: string; text: string }) => {
    const memory = memoryState.find((item) => item.id === input.memoryId && item.botId === input.botId);
    if (!memory) throw new Error("Memory not found.");
    memory.text = input.text;
    memory.updatedAt = "2026-08-25T12:00:00.000Z";
    return memory;
  });
  deleteMemory = vi.fn(async (input: { botId: string; memoryId: string }) => {
    memoryState = memoryState.filter((item) => item.id !== input.memoryId || item.botId !== input.botId);
  });
  clearMemories = vi.fn(async (botId: string) => {
    memoryState = memoryState.filter((item) => item.botId !== botId);
  });

  activeMock = createMockOpenBot();
  activeMock.api.agent.listMemories = listMemories;
  activeMock.api.agent.createMemory = createMemory;
  activeMock.api.agent.updateMemory = updateMemory;
  activeMock.api.agent.deleteMemory = deleteMemory;
  activeMock.api.agent.clearMemories = clearMemories;
  activeMock.api.agent.onEvent = vi.fn((listener: (event: AgentEvent) => void) => {
    emitAgentEvent = listener;
    return () => undefined;
  });
  window.openbot = activeMock.api;
});

describe("AgentMemoriesModal", () => {
  it("shows the empty state, adds a memory, and refreshes after a memory event", async () => {
    const onCountChange = vi.fn();
    render(() => (
      <AgentMemoriesModal botId="chief" botName="Chief" open onOpenChange={vi.fn()} onCountChange={onCountChange} />
    ));

    expect(await screen.findByRole("dialog", { name: "Memories" })).toBeInTheDocument();
    expect(await screen.findByText("This agent has no saved memories yet.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "New memory" })).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Add memory" }));
    let newMemoryInput = screen.getByRole("textbox", { name: "New memory" });
    await fireEvent.keyDown(newMemoryInput, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "New memory" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Memories" })).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: "Add memory" }));
    newMemoryInput = screen.getByRole("textbox", { name: "New memory" });
    await fireEvent.input(newMemoryInput, {
      target: { value: "Prefers short status reports." },
    });
    const saveMemoryButton = screen.getByRole("button", { name: "Save memory" });
    await fireEvent.click(saveMemoryButton);

    await waitFor(() =>
      expect(createMemory).toHaveBeenCalledWith({
        botId: "chief",
        text: "Prefers short status reports.",
      }),
    );
    expect(await screen.findByText("Prefers short status reports.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "New memory" })).not.toBeInTheDocument();
    expect(screen.getByText(/Added manually/)).toBeInTheDocument();
    expect(onCountChange).toHaveBeenLastCalledWith(1);
    expect(trackMemoryAnalytics).toHaveBeenCalledWith("memory_action", {
      action: "create",
      result: "succeeded",
    });

    memoryState.push({ ...firstMemory, id: "memory-remote", text: "Remote change" });
    emitAgentEvent?.({ type: "memories-changed", botId: "chief" });
    expect(await screen.findByText("Remote change")).toBeInTheDocument();
    expect(onCountChange).toHaveBeenLastCalledWith(2);
  });

  it("edits a memory and deletes it without confirmation", async () => {
    memoryState = [{ ...firstMemory }];
    render(() => (
      <AgentMemoriesModal botId="chief" botName="Chief" open onOpenChange={vi.fn()} onCountChange={vi.fn()} />
    ));

    expect(await screen.findByText("Uses metric units.")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Edit memory: Uses metric units." }));
    const editInput = screen.getByRole("textbox", { name: "Edit memory" });
    await fireEvent.input(editInput, {
      target: { value: "Uses SI units." },
    });
    const saveButton = screen.getByRole("button", { name: "Save" });
    await fireEvent.click(saveButton);
    expect(await screen.findByText("Uses SI units.")).toBeInTheDocument();
    expect(updateMemory).toHaveBeenCalledWith({ botId: "chief", memoryId: "memory-1", text: "Uses SI units." });

    const deleteButton = screen.getByRole("button", { name: "Delete memory" });
    await waitFor(() => expect(deleteButton).toBeEnabled());
    await fireEvent.click(deleteButton);
    await waitFor(() => expect(deleteMemory).toHaveBeenCalledWith({ botId: "chief", memoryId: "memory-1" }));
    expect(screen.queryByRole("dialog", { name: "Delete this memory?" })).not.toBeInTheDocument();
    expect(await screen.findByText("This agent has no saved memories yet.")).toBeInTheDocument();
  });

  it("requires confirmation before clearing all memories", async () => {
    memoryState = [{ ...firstMemory }, { ...firstMemory, id: "memory-2", text: "Prefers short status reports." }];
    render(() => (
      <AgentMemoriesModal botId="chief" botName="Chief" open onOpenChange={vi.fn()} onCountChange={vi.fn()} />
    ));

    expect(await screen.findByText("Uses metric units.")).toBeInTheDocument();
    const clearButton = screen.getByRole("button", { name: "Clear all memories" });
    await fireEvent.click(clearButton);
    const confirmation = await screen.findByRole("dialog", { name: "Clear all memories?" });
    const originalModal = document.querySelector(".agent-memories-modal");
    if (!(originalModal instanceof HTMLElement)) throw new Error("Expected the Memories modal to stay mounted.");
    expect(originalModal).toBeVisible();
    expect(within(originalModal).getByText("Uses metric units.")).toBeInTheDocument();
    expect(within(confirmation).getByText(/all 2 saved memories/)).toBeInTheDocument();
    expect(within(confirmation).getByText(/Original messages will stay/)).toBeInTheDocument();
    expect(clearMemories).not.toHaveBeenCalled();

    await fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    const restoredModal = await screen.findByRole("dialog", { name: "Memories" });
    const restoredClearButton = within(restoredModal).getByRole("button", { name: "Clear all memories" });

    await fireEvent.click(restoredClearButton);
    await fireEvent.click(
      within(await screen.findByRole("dialog", { name: "Clear all memories?" })).getByRole("button", {
        name: "Clear all memories",
      }),
    );
    await waitFor(() => expect(clearMemories).toHaveBeenCalledWith("chief"));
    expect(await screen.findByText("This agent has no saved memories yet.")).toBeInTheDocument();
  });

  it("shows loading errors and closes from the close button", async () => {
    listMemories.mockRejectedValueOnce(new Error("Memory service is unavailable."));
    const onOpenChange = vi.fn();
    render(() => (
      <AgentMemoriesModal botId="chief" botName="Chief" open onOpenChange={onOpenChange} onCountChange={vi.fn()} />
    ));

    expect(await screen.findByRole("alert")).toHaveTextContent("Memory service is unavailable.");
    await fireEvent.click(screen.getByRole("button", { name: "Close memories" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
