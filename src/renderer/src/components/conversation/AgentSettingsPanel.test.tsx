import type { Routine } from "@openbot/contracts/ipc";
import { render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STORY_AGENT_STATUS, STORY_BOTS, STORY_MODELS } from "../../preview/fixtures";
import { createMockOpenBot, type MockOpenBotControls } from "../../preview/mock-openbot";
import AgentSettingsPanel from "./AgentSettingsPanel";

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

let mock: MockOpenBotControls;

beforeEach(() => {
  mock = createMockOpenBot({ routines: { chief: [routine] } });
  window.openbot = mock.api;
});

afterEach(() => {
  mock.dispose();
  vi.restoreAllMocks();
});

describe("AgentSettingsPanel", () => {
  it("opens the requested routine when the settings panel mounts", async () => {
    const bot = STORY_BOTS[0];
    if (!bot) throw new Error("Expected the Chief fixture.");
    const onRoutineSelectionRequestHandled = vi.fn();
    render(() => (
      <AgentSettingsPanel
        bot={bot}
        agentStatus={STORY_AGENT_STATUS}
        modelOptions={STORY_MODELS}
        working={false}
        maxWidth={() => 800}
        onClose={vi.fn()}
        onWidthChange={vi.fn()}
        onUpdateBot={vi.fn(async () => undefined)}
        onSetAgentAvatar={vi.fn(async () => undefined)}
        routineSelectionRequest={{ routineId: routine.id, routineName: routine.name, nonce: 1 }}
        onRoutineSelectionRequestHandled={onRoutineSelectionRequestHandled}
      />
    ));

    expect(await screen.findByRole("textbox", { name: "Name" })).toHaveValue("Morning brief");
    expect(onRoutineSelectionRequestHandled).toHaveBeenCalledWith(1);
  });
});
