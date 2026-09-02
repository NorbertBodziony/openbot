import type { Routine, RoutineRun } from "@openbot/contracts/ipc";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockOpenBot, type MockOpenBotControls } from "../../preview/mock-openbot";
import { AgentRoutinesSettings, type RoutineSelectionRequest } from "./AgentRoutinesSettings";

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

let mock: MockOpenBotControls | undefined;

function setupOpenBot(options?: Parameters<typeof createMockOpenBot>[0]): MockOpenBotControls {
  mock?.dispose();
  mock = createMockOpenBot(options);
  window.openbot = mock.api;
  return mock;
}

afterEach(() => {
  mock?.dispose();
  mock = undefined;
  vi.restoreAllMocks();
});

describe("AgentRoutinesSettings", () => {
  it("opens the current routine from a message selection and can reopen it", async () => {
    const renamedRoutine = { ...routine, name: "Renamed morning brief" };
    const mock = setupOpenBot({ routines: { chief: [renamedRoutine] } });
    const listRoutineRuns = vi.spyOn(mock.api.agent, "listRoutineRuns");
    const onSelectionRequestHandled = vi.fn();
    const [selectionRequest, setSelectionRequest] = createSignal<RoutineSelectionRequest | null>({
      routineId: routine.id,
      routineName: "Old morning brief",
      nonce: 1,
    });
    render(() => (
      <AgentRoutinesSettings
        botId="chief"
        onCountChange={vi.fn()}
        selectionRequest={selectionRequest()}
        onSelectionRequestHandled={onSelectionRequestHandled}
      />
    ));

    expect(await screen.findByRole("textbox", { name: "Name" })).toHaveValue("Renamed morning brief");
    await waitFor(() =>
      expect(listRoutineRuns).toHaveBeenCalledWith({ botId: "chief", routineId: "routine-1", limit: 10 }),
    );
    expect(onSelectionRequestHandled).toHaveBeenCalledWith(1);

    await fireEvent.click(screen.getByRole("button", { name: "Back to Routines" }));
    setSelectionRequest({ routineId: routine.id, routineName: routine.name, nonce: 2 });
    expect(await screen.findByRole("textbox", { name: "Name" })).toHaveValue("Renamed morning brief");
    expect(onSelectionRequestHandled).toHaveBeenCalledWith(2);
  });

  it("keeps the routine list open and reports a missing message selection", async () => {
    setupOpenBot();
    const onSelectionRequestHandled = vi.fn();
    render(() => (
      <AgentRoutinesSettings
        botId="chief"
        onCountChange={vi.fn()}
        selectionRequest={{ routineId: "deleted-routine", routineName: "Old brief", nonce: 1 }}
        onSelectionRequestHandled={onSelectionRequestHandled}
      />
    ));

    expect(await screen.findByText("No routines yet.")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent('Routine "Old brief" no longer exists.');
    expect(screen.queryByRole("textbox", { name: "Name" })).not.toBeInTheDocument();
    expect(onSelectionRequestHandled).toHaveBeenCalledWith(1);
  });

  it("protects unsaved changes before opening a different selected routine", async () => {
    const eveningRoutine: Routine = {
      ...routine,
      id: "routine-2",
      name: "Evening brief",
      trigger: { ...routine.trigger, id: "trigger-2", routineId: "routine-2" },
    };
    setupOpenBot({ routines: { chief: [routine, eveningRoutine] } });
    const [selectionRequest, setSelectionRequest] = createSignal<RoutineSelectionRequest | null>({
      routineId: routine.id,
      routineName: routine.name,
      nonce: 1,
    });
    render(() => <AgentRoutinesSettings botId="chief" onCountChange={vi.fn()} selectionRequest={selectionRequest()} />);

    const name = await screen.findByRole("textbox", { name: "Name" });
    await fireEvent.input(name, { target: { value: "Unsaved morning brief" } });
    setSelectionRequest({ routineId: eveningRoutine.id, routineName: eveningRoutine.name, nonce: 2 });
    await fireEvent.click(await screen.findByRole("button", { name: "Keep editing" }));
    expect(name).toHaveValue("Unsaved morning brief");

    setSelectionRequest({ routineId: eveningRoutine.id, routineName: eveningRoutine.name, nonce: 3 });
    await fireEvent.click(await screen.findByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Evening brief"));
  });

  it("protects unsaved changes before opening a run in chat", async () => {
    const mock = setupOpenBot({ routines: { chief: [routine] } });
    vi.spyOn(mock.api.agent, "listRoutineRuns").mockResolvedValue([run]);
    const onOpenRun = vi.fn();
    render(() => <AgentRoutinesSettings botId="chief" onCountChange={vi.fn()} onOpenRun={onOpenRun} />);

    await fireEvent.click(await screen.findByRole("button", { name: /Morning brief/ }));
    await fireEvent.input(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Unsaved morning brief" },
    });
    const runLink = await screen.findByRole("button", { name: /^Open .* in chat$/ });
    await fireEvent.click(runLink);
    await fireEvent.click(await screen.findByRole("button", { name: "Keep editing" }));
    expect(onOpenRun).not.toHaveBeenCalled();

    await fireEvent.click(runLink);
    await fireEvent.click(await screen.findByRole("button", { name: "Discard changes" }));
    expect(onOpenRun).toHaveBeenCalledWith("delivery-1");
  });

  it("keeps an empty draft local and discards it on Back", async () => {
    const mock = setupOpenBot();
    const createRoutine = vi.spyOn(mock.api.agent, "createRoutine");
    render(() => <AgentRoutinesSettings botId="chief" onCountChange={vi.fn()} />);

    expect(await screen.findByText("No routines yet.")).toBeInTheDocument();
    const createButton = screen.getByRole("button", { name: "Create Routine" });
    await fireEvent.click(createButton);
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("");
    await fireEvent.click(screen.getByRole("button", { name: "Back to Routines" }));

    expect(await screen.findByText("No routines yet.")).toBeInTheDocument();
    expect(createRoutine).not.toHaveBeenCalled();
  });

  it("asks before discarding an edited draft on Back", async () => {
    setupOpenBot({ routines: { chief: [routine] } });
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
    setupOpenBot({ routines: { chief: [routine] } });
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
    const mock = setupOpenBot();
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
    const mock = setupOpenBot({ routines: { chief: [routine] } });
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
    expect(deleteRoutine).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: "Delete now" }));
    await waitFor(() => expect(deleteRoutine).toHaveBeenCalledWith({ botId: "chief", routineId: "routine-1" }));
    expect(await screen.findByText("No routines yet.")).toBeInTheDocument();
  });

  it("blocks editor navigation while Save is running", async () => {
    const mock = setupOpenBot({ routines: { chief: [routine] } });
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
    const mock = setupOpenBot({ routines: { chief: [routine] } });
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
    setupOpenBot({ routines: { chief: [customTimeRoutine] } });
    render(() => <AgentRoutinesSettings botId="chief" onCountChange={vi.fn()} />);

    await fireEvent.click(await screen.findByRole("button", { name: /Morning brief/ }));
    await fireEvent.click(screen.getByRole("button", { name: /On weekdays at 7:07 AM/ }));
    const timePicker = screen.getByRole("button", { name: /^Time/ });
    expect(timePicker).toHaveTextContent("7:07 AM");
    await fireEvent.pointerDown(timePicker, { pointerType: "mouse", button: 0 });

    expect(screen.getAllByRole("option")).toHaveLength(97);
    expect(screen.getByRole("option", { name: "7:07 AM" })).toBeInTheDocument();
  });

  it("opens the time picker from the keyboard", async () => {
    setupOpenBot({ routines: { chief: [routine] } });
    render(() => <AgentRoutinesSettings botId="chief" onCountChange={vi.fn()} />);

    await fireEvent.click(await screen.findByRole("button", { name: /Morning brief/ }));
    await fireEvent.click(screen.getByRole("button", { name: /On weekdays at 7:00 AM/ }));
    const timePicker = screen.getByRole("button", { name: /^Time/ });
    timePicker.focus();
    await fireEvent.keyDown(timePicker, { key: "Enter" });

    expect(screen.getByRole("listbox")).toBeVisible();
    expect(screen.getByRole("option", { name: "7:00 AM" })).toBeInTheDocument();
  });
});
