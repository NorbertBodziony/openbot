import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STORY_AGENT_STATUS, STORY_BOTS, STORY_MODELS } from "../../preview/fixtures";
import { createMockOpenBot, type MockOpenBotControls } from "../../preview/mock-openbot";
import AgentSettingsPanel, { type AgentRuntimeSettings } from "./AgentSettingsPanel";

let mock: MockOpenBotControls | undefined;

afterEach(() => {
  mock?.dispose();
  mock = undefined;
});

describe("AgentSettingsPanel", () => {
  it("restores the previous model when saving runtime settings fails", async () => {
    mock = createMockOpenBot();
    window.openbot = mock.api;
    // Sol does not run under Claude, and Claude does not offer Extra high, so a rejected save has
    // all three runtime fields to put back at once.
    const runtimeSettings: AgentRuntimeSettings = {
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
    };
    const onUpdateRuntimeSettings = vi.fn(async () => false);
    render(() => (
      <AgentSettingsPanel
        bot={{ ...STORY_BOTS[0], provider: "codex", model: "gpt-5.6-sol", reasoningEffort: "xhigh" }}
        runtimeSettings={runtimeSettings}
        agentStatus={STORY_AGENT_STATUS}
        modelOptions={STORY_MODELS}
        working={false}
        maxWidth={() => 640}
        onClose={vi.fn()}
        onWidthChange={vi.fn()}
        onUpdateBot={vi.fn(async () => undefined)}
        onUpdateRuntimeSettings={onUpdateRuntimeSettings}
        onSetAgentAvatar={vi.fn(async () => undefined)}
      />
    ));

    await fireEvent.click(await screen.findByRole("button", { name: "Agent model: Sol" }));
    const dialog = screen.getByRole("dialog", { name: "Choose agent model" });
    await fireEvent.click(within(dialog).getByRole("tab", { name: /^Claude:/ }));
    await fireEvent.click(within(dialog).getByRole("option", { name: "Claude Sonnet 5" }));

    await waitFor(() =>
      expect(onUpdateRuntimeSettings).toHaveBeenCalledWith(
        STORY_BOTS[0].id,
        { provider: "claude", model: "claude-sonnet-5", reasoningEffort: "high" },
        { provider: "claude", model: "claude-sonnet-5", reasoningEffort: "high" },
      ),
    );
    await fireEvent.keyDown(dialog, { key: "Escape" });

    expect(await screen.findByText("Could not save agent settings.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Agent model: Sol" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Agent reasoning level/ })).toHaveTextContent("Extra high");
  });
});
