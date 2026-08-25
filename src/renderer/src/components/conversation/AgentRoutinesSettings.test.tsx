import type { Routine, RoutineRun } from "@openbot/contracts/ipc";
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockOpenBot, type MockOpenBotControls } from "../../preview/mock-openbot";
import { AgentRoutinesSettings } from "./AgentRoutinesSettings";

const routine: Routine = {
  id: "routine-1",
  botId: "chief",
  name: "Morning brief",
  instruction: "Summarize the overnight changes.",
  active: true,
  timezone: "Europe/Warsaw",
  trigger: {
    id: "trigger-1",
    routineId: "routine-1",
    schedule: { kind: "weekdays", time: "07:00" },
    nextRunAt: "2026-08-26T05:00:00.000Z",
    createdAt: "2026-08-25T12:00:00.000Z",
    updatedAt: "2026-08-25T12:00:00.000Z",
  },
  createdAt: "2026-08-25T12:00:00.000Z",
  updatedAt: "2026-08-25T12:00:00.000Z",
};

const run: RoutineRun = {
  id: "run-1",
  routineId: "routine-1",
  botId: "chief",
  triggerId: "trigger-1",
  kind: "scheduled",
  scheduledFor: "2026-08-25T05:00:00.000Z",
  routineName: "Morning brief",
  instruction: "Summarize the overnight changes.",
  deliveryId: "delivery-1",
  status: "needs-attention",
  error: null,
  createdAt: "2026-08-25T05:00:00.000Z",
  updatedAt: "2026-08-25T05:01:00.000Z",
};

let mock: MockOpenBotControls;

beforeEach(() => {
  mock = createMockOpenBot();
  window.openbot = mock.api;
});

afterEach(() => {
  mock.dispose();
  vi.restoreAllMocks();
});

describe("AgentRoutinesSettings", () => {
  it("keeps the routines body scrollable with dynamic scroll fades", async () => {
    render(() => <AgentRoutinesSettings botId="chief" onCountChange={vi.fn()} />);
    await screen.findByText("No routines yet.");
    const body = document.querySelector<HTMLElement>(".agent-routines-body");
    if (!body) throw new Error("Expected the routines scroll body.");

    Object.defineProperties(body, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, value: 0, writable: true },
    });

    await fireEvent.scroll(body);
    expect(body).not.toHaveClass("scroll-fade-top");
    expect(body).toHaveClass("scroll-fade-bottom");

    body.scrollTop = 300;
    await fireEvent.scroll(body);
    expect(body).toHaveClass("scroll-fade-top");
    expect(body).not.toHaveClass("scroll-fade-bottom");
  });

  it("keeps an empty draft local and discards it on Back", async () => {
    const createRoutine = vi.spyOn(mock.api.agent, "createRoutine");
    render(() => <AgentRoutinesSettings botId="chief" onCountChange={vi.fn()} />);

    expect(await screen.findByText("No routines yet.")).toBeInTheDocument();
    const createButton = screen.getByRole("button", { name: "Create Routine" });
    const backButton = screen.getByRole("button", { name: "Back to settings" });
    expect(createButton.closest("header")).toBeInTheDocument();
    expect(createButton.className).toBe(backButton.className);
    await fireEvent.click(createButton);
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("");
    await fireEvent.click(screen.getByRole("button", { name: "Back to Routines" }));

    expect(await screen.findByText("No routines yet.")).toBeInTheDocument();
    expect(createRoutine).not.toHaveBeenCalled();
  });

  it("asks before discarding an edited draft on Back", async () => {
    mock.dispose();
    mock = createMockOpenBot({ routines: { chief: [routine] } });
    window.openbot = mock.api;
    render(() => <AgentRoutinesSettings botId="chief" onCountChange={vi.fn()} />);

    await fireEvent.click(await screen.findByRole("button", { name: /Morning brief/ }));
    const name = screen.getByRole("textbox", { name: "Name" });
    await fireEvent.input(name, { target: { value: "Changed morning brief" } });
    await fireEvent.click(screen.getByRole("button", { name: "Back to Routines" }));

    expect(screen.getByRole("dialog")).toHaveAccessibleName("Discard changes?");
    await fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Changed morning brief");

    await fireEvent.click(screen.getByRole("button", { name: "Back to Routines" }));
    await fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(await screen.findByRole("button", { name: /Morning brief/ })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Name" })).not.toBeInTheDocument();
  });

  it("runs the requested Close action after discard confirmation", async () => {
    mock.dispose();
    mock = createMockOpenBot({ routines: { chief: [routine] } });
    window.openbot = mock.api;
    const onClose = vi.fn();
    render(() => <AgentRoutinesSettings botId="chief" onCountChange={vi.fn()} onClose={onClose} />);

    await fireEvent.click(await screen.findByRole("button", { name: /Morning brief/ }));
    await fireEvent.input(screen.getByRole("textbox", { name: "Instruction" }), {
      target: { value: "Changed instruction" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Close details" }));

    expect(onClose).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("saves a valid draft only after the user clicks Save", async () => {
    const createRoutine = vi.spyOn(mock.api.agent, "createRoutine");
    const onCountChange = vi.fn();
    render(() => <AgentRoutinesSettings botId="chief" onCountChange={onCountChange} />);

    await screen.findByText("No routines yet.");
    await fireEvent.click(screen.getByRole("button", { name: "Create Routine" }));
    await fireEvent.click(screen.getByRole("button", { name: /On every day at/ }));
    const scheduleType = screen.getByRole("button", { name: /^Frequency/ });
    await fireEvent.pointerDown(scheduleType, { pointerType: "mouse", button: 0 });
    await fireEvent.click(screen.getByRole("option", { name: "Weekdays" }));
    expect(scheduleType).toHaveTextContent("Weekdays");
    await fireEvent.input(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Morning brief" },
    });
    const instruction = screen.getByRole("textbox", { name: "Instruction" });
    await fireEvent.input(instruction, { target: { value: "Summarize the overnight changes." } });
    await fireEvent.blur(instruction);

    expect(createRoutine).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(createRoutine).toHaveBeenCalledOnce());
    expect(createRoutine).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: "chief",
        name: "Morning brief",
        instruction: "Summarize the overnight changes.",
        active: true,
        timezone: expect.any(String),
        schedule: { kind: "weekdays", time: "09:00" },
      }),
    );
    expect(onCountChange).toHaveBeenLastCalledWith(1);
  });

  it("updates Active, starts a test run, shows history, and confirms deletion", async () => {
    mock.dispose();
    mock = createMockOpenBot({ routines: { chief: [routine] } });
    window.openbot = mock.api;
    const updateRoutine = vi.spyOn(mock.api.agent, "updateRoutine");
    const testRoutine = vi.spyOn(mock.api.agent, "testRoutine");
    const deleteRoutine = vi.spyOn(mock.api.agent, "deleteRoutine");
    vi.spyOn(mock.api.agent, "listRoutineRuns").mockResolvedValue([run]);
    render(() => <AgentRoutinesSettings botId="chief" onCountChange={vi.fn()} />);

    await fireEvent.click(await screen.findByRole("button", { name: /Morning brief/ }));
    expect(await screen.findByRole("img", { name: "Needs attention" })).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("switch", { name: "Routine active" }));
    expect(updateRoutine).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Test run" })).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateRoutine).toHaveBeenCalledWith(expect.objectContaining({ active: false })));
    expect(screen.getByText("Paused", { selector: "label" })).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: "Test run" }));
    await waitFor(() => expect(testRoutine).toHaveBeenCalledWith({ botId: "chief", routineId: "routine-1" }));

    await fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const actions = screen.getByRole("button", { name: "Delete now" }).parentElement;
    if (!actions) throw new Error("Expected routine action controls");
    expect(deleteRoutine).not.toHaveBeenCalled();
    await fireEvent.click(within(actions).getByRole("button", { name: "Delete now" }));
    await waitFor(() => expect(deleteRoutine).toHaveBeenCalledWith({ botId: "chief", routineId: "routine-1" }));
    expect(await screen.findByText("No routines yet.")).toBeInTheDocument();
  });

  it("blocks editor navigation while Save is running", async () => {
    mock.dispose();
    mock = createMockOpenBot({ routines: { chief: [routine] } });
    window.openbot = mock.api;
    let resolveUpdate: ((value: Routine) => void) | undefined;
    vi.spyOn(mock.api.agent, "updateRoutine").mockImplementation(
      () =>
        new Promise<Routine>((resolve) => {
          resolveUpdate = resolve;
        }),
    );
    render(() => <AgentRoutinesSettings botId="chief" onCountChange={vi.fn()} onClose={vi.fn()} />);

    await fireEvent.click(await screen.findByRole("button", { name: /Morning brief/ }));
    await fireEvent.input(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Changed morning brief" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByRole("button", { name: "Back to Routines" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close details" })).toBeDisabled();
    resolveUpdate?.({ ...routine, name: "Changed morning brief" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Test run" })).toBeEnabled());
  });

  it("offers 96 quarter-hour values and saves a selected time", async () => {
    mock.dispose();
    mock = createMockOpenBot({ routines: { chief: [routine] } });
    window.openbot = mock.api;
    const updateRoutine = vi.spyOn(mock.api.agent, "updateRoutine");
    render(() => <AgentRoutinesSettings botId="chief" onCountChange={vi.fn()} />);

    await fireEvent.click(await screen.findByRole("button", { name: /Morning brief/ }));
    await fireEvent.click(screen.getByRole("button", { name: /On weekdays at 7:00 AM/ }));
    const timePicker = screen.getByRole("button", { name: /^Time/ });
    await fireEvent.pointerDown(timePicker, { pointerType: "mouse", button: 0 });

    expect(screen.getAllByRole("option")).toHaveLength(96);
    expect(screen.getByRole("option", { name: "12:00 AM" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "11:45 PM" })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("option", { name: "7:15 AM" }));

    expect(updateRoutine).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(updateRoutine).toHaveBeenCalledWith(
        expect.objectContaining({ schedule: { kind: "weekdays", time: "07:15" } }),
      ),
    );
  });

  it("keeps a non-grid API time as the current picker option", async () => {
    const customTimeRoutine: Routine = {
      ...routine,
      trigger: { ...routine.trigger, schedule: { kind: "weekdays", time: "07:07" } },
    };
    mock.dispose();
    mock = createMockOpenBot({ routines: { chief: [customTimeRoutine] } });
    window.openbot = mock.api;
    render(() => <AgentRoutinesSettings botId="chief" onCountChange={vi.fn()} />);

    await fireEvent.click(await screen.findByRole("button", { name: /Morning brief/ }));
    await fireEvent.click(screen.getByRole("button", { name: /On weekdays at 7:07 AM/ }));
    const timePicker = screen.getByRole("button", { name: /^Time/ });
    expect(timePicker).toHaveTextContent("7:07 AM");
    await fireEvent.pointerDown(timePicker, { pointerType: "mouse", button: 0 });

    expect(screen.getAllByRole("option")).toHaveLength(97);
    expect(screen.getByRole("option", { name: "7:07 AM" })).toHaveAttribute("data-selected");
  });

  it("opens the time picker from the keyboard", async () => {
    mock.dispose();
    mock = createMockOpenBot({ routines: { chief: [routine] } });
    window.openbot = mock.api;
    render(() => <AgentRoutinesSettings botId="chief" onCountChange={vi.fn()} />);

    await fireEvent.click(await screen.findByRole("button", { name: /Morning brief/ }));
    await fireEvent.click(screen.getByRole("button", { name: /On weekdays at 7:00 AM/ }));
    const timePicker = screen.getByRole("button", { name: /^Time/ });
    timePicker.focus();
    await fireEvent.keyDown(timePicker, { key: "Enter" });

    expect(screen.getByRole("listbox")).toBeVisible();
    expect(screen.getByRole("option", { name: "7:00 AM" })).toHaveAttribute("data-selected");
  });
});
