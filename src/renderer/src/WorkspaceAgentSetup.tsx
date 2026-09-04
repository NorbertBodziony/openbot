import { useAgentActions } from "./agent-actions";
import { useAgents } from "./agents";
import { FIRST_BOT_SUGGESTIONS, FirstBotSetup } from "./components/FirstAgentSetup";

/**
 * The create-a-Bot form, which takes over the conversation pane instead of
 * opening over it. `mode` is derived from the Bot list rather than passed in
 * because the first Bot and the fifth are the same command with different copy.
 */
export function WorkspaceBotSetup() {
  const { botList, botSetupDraft, setBotSetupDraft, botSetupError, creatingAgent, cancelBotSetup } = useAgents();
  const { createAgent } = useAgentActions();

  return (
    <FirstBotSetup
      value={botSetupDraft()}
      suggestions={FIRST_BOT_SUGGESTIONS}
      mode={botList().length === 0 ? "first" : "additional"}
      submitting={creatingAgent()}
      error={botSetupError()}
      onChange={setBotSetupDraft}
      onSubmit={createAgent}
      onCancel={botList().length > 0 ? cancelBotSetup : undefined}
    />
  );
}
