import type { AgentModelId, AgentProviderId, AgentReasoningEffort, UpdateAgentInput } from "@openbot/contracts/ipc";
import type { AgentRuntimeSettings, AgentRuntimeSettingsPatch } from "../AgentSettingsPanel";
import type { ConversationProps } from "../ConversationView";
import { agentConversationKey } from "../conversation-keys";

export function runtimeSettingsEqual(left: AgentRuntimeSettings, right: AgentRuntimeSettings): boolean {
  return (
    left.provider === right.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort
  );
}

export function isCompleteRuntimeSettingsPatch(updates: AgentRuntimeSettingsPatch): updates is AgentRuntimeSettings {
  return "provider" in updates && "model" in updates;
}

export interface SettingsStoreDeps {
  props: ConversationProps;
  runtimeSettingsAttempts: Map<
    string,
    {
      generation: number;
      pending: boolean;
      settings: {
        provider: AgentProviderId;
        model: AgentModelId;
        reasoningEffort: AgentReasoningEffort;
      };
    }
  >;
  runtimeSettingsSaveTails: Map<string, Promise<boolean>>;
  settingsProvider: () => AgentProviderId;
  setSettingsProvider: (provider: AgentProviderId) => void;
  settingsModel: () => AgentModelId;
  setSettingsModel: (model: AgentModelId) => void;
  settingsReasoning: () => AgentReasoningEffort;
  setSettingsReasoning: (effort: AgentReasoningEffort) => void;
  setComposerError: (error: string | null) => void;
  viewIsMounted: () => boolean;
  saveAgentPatch: (updates: Omit<UpdateAgentInput, "agentId">, targetAgentId?: string) => Promise<boolean>;
}

export function createSettingsStore(deps: SettingsStoreDeps) {
  async function saveRuntimeSettings(
    settings: AgentRuntimeSettings,
    updates: AgentRuntimeSettingsPatch,
    errorMessage: string | null,
    targetAgentId = deps.props.agent?.id,
  ): Promise<boolean> {
    const agentId = targetAgentId;
    if (!agentId) return false;
    // Both maps live on the controller, which outlives one server, so the key
    // has to say which server the settings belong to.
    const settingsKey = agentConversationKey(deps.props.server?.id ?? "local", agentId);
    const previousAttempt = deps.runtimeSettingsAttempts.get(settingsKey);
    const generation = (previousAttempt?.generation ?? 0) + 1;
    deps.runtimeSettingsAttempts.set(settingsKey, { generation, pending: true, settings });
    if (errorMessage) deps.setComposerError(null);

    const previousSave = deps.runtimeSettingsSaveTails.get(settingsKey);
    let releaseSave!: (baseValid: boolean) => void;
    const saveTail = new Promise<boolean>((resolve) => {
      releaseSave = resolve;
    });
    deps.runtimeSettingsSaveTails.set(settingsKey, saveTail);
    let saved: boolean;
    let baseValid = true;
    let abandoned = false;
    try {
      if (previousSave) baseValid = await previousSave;
      // `agent.updateAgent` is routed by the server main has selected, not by the
      // agent id in its payload, so a save still queued behind an earlier one when
      // the user leaves would be applied to whichever server they arrive at. It
      // belongs to the one it was made on, and that one is gone.
      abandoned = !deps.viewIsMounted();
      const completePatch = isCompleteRuntimeSettingsPatch(updates);
      saved = !abandoned && (baseValid || completePatch) ? await deps.saveAgentPatch(updates, agentId) : false;
      if (completePatch) baseValid = saved;
    } finally {
      releaseSave(baseValid);
      if (deps.runtimeSettingsSaveTails.get(settingsKey) === saveTail) {
        deps.runtimeSettingsSaveTails.delete(settingsKey);
      }
    }
    const latestAttempt = deps.runtimeSettingsAttempts.get(settingsKey);
    if (latestAttempt?.generation !== generation) return true;
    latestAttempt.pending = false;
    // Nothing left to report to: the pickers, the composer error and the agent
    // this would roll back to all belonged to the conversation that is gone.
    if (abandoned) return false;
    if (saved) {
      const activeAgent = deps.props.agent;
      if (activeAgent?.id === agentId) {
        deps.setSettingsProvider(activeAgent.provider);
        deps.setSettingsModel(activeAgent.model);
        deps.setSettingsReasoning(activeAgent.reasoningEffort);
      }
      return true;
    }

    const activeAgent = deps.props.agent;
    const currentSettings = {
      provider: deps.settingsProvider(),
      model: deps.settingsModel(),
      reasoningEffort: deps.settingsReasoning(),
    };
    if (activeAgent?.id !== agentId || !runtimeSettingsEqual(currentSettings, settings)) return false;
    deps.setSettingsProvider(activeAgent.provider);
    deps.setSettingsModel(activeAgent.model);
    deps.setSettingsReasoning(activeAgent.reasoningEffort);
    if (errorMessage) deps.setComposerError(errorMessage);
    return false;
  }

  async function updateRuntimeSettings(
    agentId: string,
    settings: AgentRuntimeSettings,
    updates: AgentRuntimeSettingsPatch,
  ): Promise<boolean> {
    if (deps.props.agent?.id === agentId) {
      deps.setSettingsProvider(settings.provider);
      deps.setSettingsModel(settings.model);
      deps.setSettingsReasoning(settings.reasoningEffort);
    }
    return saveRuntimeSettings(settings, updates, null, agentId);
  }

  async function selectModel(
    model: AgentModelId,
    provider: AgentProviderId,
    persist = true,
    reportComposerError = false,
  ): Promise<boolean> {
    const option = deps.props.modelOptions.find(
      (candidate) => candidate.provider === provider && candidate.id === model,
    );
    if (!option) return false;
    const reasoningEffort = option.supportedReasoningEfforts.includes(deps.settingsReasoning())
      ? deps.settingsReasoning()
      : option.defaultReasoningEffort;
    deps.setSettingsProvider(provider);
    deps.setSettingsModel(model);
    deps.setSettingsReasoning(reasoningEffort);
    if (!persist) return true;
    return saveRuntimeSettings(
      { provider, model, reasoningEffort },
      { provider, model, reasoningEffort },
      reportComposerError ? "Could not change model. Try again." : null,
    );
  }

  async function selectAndConfirmModel(model: AgentModelId, provider: AgentProviderId): Promise<void> {
    await selectModel(model, provider, true, true);
  }

  async function selectAndConfirmReasoning(effort: AgentReasoningEffort): Promise<void> {
    const option = deps.props.modelOptions.find(
      (candidate) => candidate.provider === deps.settingsProvider() && candidate.id === deps.settingsModel(),
    );
    if (!option?.supportedReasoningEfforts.includes(effort)) return;
    const settings = {
      provider: deps.settingsProvider(),
      model: deps.settingsModel(),
      reasoningEffort: effort,
    };
    deps.setSettingsReasoning(effort);
    await saveRuntimeSettings(settings, { reasoningEffort: effort }, "Could not change effort. Try again.");
  }

  return {
    saveRuntimeSettings,
    updateRuntimeSettings,
    selectModel,
    selectAndConfirmModel,
    selectAndConfirmReasoning,
  };
}

export type SettingsStore = ReturnType<typeof createSettingsStore>;
