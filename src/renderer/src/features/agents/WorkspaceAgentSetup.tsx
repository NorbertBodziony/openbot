import { useAgentActions } from "./agent-actions";
import { useAgents } from "./agents-context";
import { FIRST_AGENT_SUGGESTIONS, FirstAgentSetup } from "./FirstAgentSetup";

/**
 * The create-an-agent form, which takes over the conversation pane instead of
 * opening over it. `mode` is derived from the agent list rather than passed in
 * because the first agent and the fifth are the same command with different copy.
 */
export function WorkspaceAgentSetup() {
  const { agentList, agentSetupDraft, setAgentSetupDraft, agentSetupError, creatingAgent, cancelAgentSetup } =
    useAgents();
  const { createAgent } = useAgentActions();

  return (
    <FirstAgentSetup
      value={agentSetupDraft()}
      suggestions={FIRST_AGENT_SUGGESTIONS}
      mode={agentList().length === 0 ? "first" : "additional"}
      submitting={creatingAgent()}
      error={agentSetupError()}
      onChange={setAgentSetupDraft}
      onSubmit={createAgent}
      onCancel={agentList().length > 0 ? cancelAgentSetup : undefined}
    />
  );
}
