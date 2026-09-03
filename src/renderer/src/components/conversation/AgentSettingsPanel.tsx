import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  AgentModelId,
  AgentModelOption,
  AgentProviderId,
  AgentReasoningEffort,
  AgentStatus,
  AvatarImageInput,
  BotAvatarHue,
  ProviderRuntimeStatus,
  UpdateBotInput,
} from "@openbot/contracts/ipc";
import { createEffect, createMemo, createSignal, createStore, For, onSettled, Show } from "solid-js";
import { normalizeAvatarFile } from "../../avatar-image";
import { AVATAR_HUE_OPTIONS, avatarCandidateSeeds, avatarHueSwatch } from "../../bloub-avatar";
import type { BotProfile } from "../../data";
import { AgentAvatar } from "../AgentAvatar";
import { PanelResizer, readPanelWidth, savePanelWidth } from "../PanelResizer";
import { ProviderModelPicker } from "../ProviderModelPicker";
import {
  Button,
  ChevronRight,
  Input,
  Popover,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
} from "../ui";
import { AgentMemoriesModal } from "./AgentMemoriesModal";
import { AgentRoutinesSettings, type RoutineSelectionRequest } from "./AgentRoutinesSettings";
import { BackIcon, SettingsForwardIcon } from "./ConversationIcons";

const SETTINGS_PANEL_STORAGE_KEY = "openbot:settings-panel-width";
const SETTINGS_PANEL_DEFAULT = 296;
const SETTINGS_PANEL_MIN = 180;
const SETTINGS_PANEL_MAX = 1600;

export interface AgentRuntimeSettings {
  provider: AgentProviderId;
  model: AgentModelId;
  reasoningEffort: AgentReasoningEffort;
}

export type AgentRuntimeSettingsPatch = AgentRuntimeSettings | Pick<AgentRuntimeSettings, "reasoningEffort">;

interface AgentSettingsPanelProps {
  bot: BotProfile;
  runtimeSettings: AgentRuntimeSettings;
  agentStatus: AgentStatus;
  modelOptions: AgentModelOption[];
  working: boolean;
  providerRuntimeStatuses?: Partial<Record<AgentProviderId, ProviderRuntimeStatus>>;
  onDownloadProvider?: (provider: AgentProviderId) => void | Promise<void>;
  onCancelProviderDownload?: (provider: AgentProviderId) => void | Promise<void>;
  onConnectProvider?: (provider: AgentProviderId) => void | Promise<void>;
  maxWidth: () => number;
  onClose: () => void;
  onWidthChange: (width: number) => void;
  onUpdateBot: (botId: string, updates: Omit<UpdateBotInput, "botId">) => Promise<void>;
  onUpdateRuntimeSettings: (
    botId: string,
    settings: AgentRuntimeSettings,
    updates: AgentRuntimeSettingsPatch,
  ) => Promise<boolean>;
  onSetAgentAvatar: (botId: string, image: AvatarImageInput | null) => Promise<void>;
  routineSelectionRequest?: RoutineSelectionRequest | null;
  onRoutineSelectionRequestHandled?: (nonce: number) => void;
  onOpenRoutineRun?: (messageId: string) => void;
}

/** The three free-text fields of the panel, each with a flag for edits made since the last save. */
interface AgentTextFields {
  description: string;
  name: string;
  title: string;
}

interface AvatarEditor {
  batch: number;
  candidateSeed: string;
  hue: BotAvatarHue | null;
  pickerOpen: boolean;
  seed: string;
  uploadBusy: boolean;
}

/**
 * Everything the panel is editing for the agent it currently shows. `fields` and `dirty` stay
 * parallel records so the props sync can write every field the user has not touched; `runtime` is
 * one record because the three settings are sent, and rolled back, together.
 */
interface AgentSettingsDraft {
  avatar: AvatarEditor;
  dirty: Record<keyof AgentTextFields, boolean>;
  fields: AgentTextFields;
  memories: { count: number; open: boolean };
  notifications: boolean;
  routines: { count: number; open: boolean };
  runtime: AgentRuntimeSettings;
  saveError: string | null;
}

export default function AgentSettingsPanel(props: AgentSettingsPanelProps) {
  const [panelWidth, setPanelWidth] = createSignal(
    readPanelWidth(SETTINGS_PANEL_STORAGE_KEY, SETTINGS_PANEL_DEFAULT, SETTINGS_PANEL_MIN, SETTINGS_PANEL_MAX),
  );
  const [draft, setDraft] = createStore<AgentSettingsDraft>({
    avatar: {
      batch: 0,
      candidateSeed: "agent",
      hue: null,
      pickerOpen: false,
      seed: "agent",
      uploadBusy: false,
    },
    dirty: { description: false, name: false, title: false },
    fields: { description: "", name: "", title: "" },
    memories: { count: 0, open: false },
    notifications: true,
    routines: { count: 0, open: false },
    runtime: { model: "gpt-5.6-luna", provider: props.bot.provider, reasoningEffort: "medium" },
    saveError: null,
  });
  const avatarUrl = () => props.bot.avatarUrl ?? null;

  /** The message under the form: every save path clears it first and reports its failure through it. */
  function setSaveError(message: string | null): void {
    setDraft((state) => {
      state.saveError = message;
    });
  }

  const selectedModel = createMemo(() =>
    props.modelOptions.find(
      (option) => option.provider === draft.runtime.provider && option.id === draft.runtime.model,
    ),
  );
  const reasoningOptions = createMemo(() => selectedModel()?.supportedReasoningEfforts ?? ["medium" as const]);
  const avatarCandidates = createMemo(() =>
    avatarCandidateSeeds(props.bot.id, draft.avatar.candidateSeed, draft.avatar.batch),
  );
  let avatarPickerRoot: HTMLDivElement | undefined;
  let avatarFileInput: HTMLInputElement | undefined;
  let lastSignature: string | undefined;
  let lastBotId: string | undefined;

  createEffect(
    () => panelWidth(),
    (width) => {
      props.onWidthChange(width);
    },
  );

  createEffect(
    () => {
      const bot = props.bot;
      const runtimeSettings = props.runtimeSettings;
      return {
        bot,
        runtimeSettings,
        signature: [
          bot.id,
          bot.name,
          bot.title,
          bot.description,
          String(bot.notifications),
          runtimeSettings.provider,
          runtimeSettings.model,
          runtimeSettings.reasoningEffort,
          bot.avatarSeed,
          String(bot.avatarHue),
        ].join("\u0000"),
      };
    },
    ({ bot, runtimeSettings, signature }) => {
      if (signature === lastSignature) return;
      const botChanged = bot.id !== lastBotId;
      // A field the user has edited keeps its draft, unless this is a different agent, whose values
      // replace the panel wholesale. Read before the write, so a fresh agent clears the flags here.
      const keep = {
        description: !botChanged && draft.dirty.description,
        name: !botChanged && draft.dirty.name,
        title: !botChanged && draft.dirty.title,
      };
      lastSignature = signature;
      lastBotId = bot.id;
      setDraft((state) => {
        if (botChanged) {
          state.dirty.description = false;
          state.dirty.name = false;
          state.dirty.title = false;
        }
        if (!keep.name) state.fields.name = bot.name;
        if (!keep.title) state.fields.title = bot.title;
        if (!keep.description) state.fields.description = bot.description;
        state.notifications = bot.notifications;
        state.runtime.provider = runtimeSettings.provider;
        state.runtime.model = runtimeSettings.model;
        state.runtime.reasoningEffort = runtimeSettings.reasoningEffort;
        state.avatar.seed = bot.avatarSeed;
        state.avatar.hue = bot.avatarHue;
        if (botChanged) {
          state.avatar.candidateSeed = bot.avatarSeed;
          state.avatar.batch = 0;
          state.avatar.pickerOpen = false;
          state.memories.open = false;
          state.routines.open = false;
        }
      });
      if (botChanged) {
        void window.openbot.agent
          .listMemories(bot.id)
          .catch(() => [])
          .then((items) => {
            setDraft((state) => {
              state.memories.count = items.length;
            });
          });
        void window.openbot.agent
          .listRoutines(bot.id)
          .catch(() => [])
          .then((items) => {
            setDraft((state) => {
              state.routines.count = items.length;
            });
          });
      }
    },
  );

  createEffect(
    () => ({ request: props.routineSelectionRequest, botId: props.bot.id }),
    ({ request }) => {
      if (request) {
        setDraft((state) => {
          state.routines.open = true;
        });
      }
    },
  );

  onSettled(() => {
    const closeAvatarPicker = (event: PointerEvent) => {
      if (!draft.avatar.pickerOpen) return;
      if (event.target instanceof Node && avatarPickerRoot?.contains(event.target)) return;
      setDraft((state) => {
        state.avatar.pickerOpen = false;
      });
    };
    window.addEventListener("pointerdown", closeAvatarPicker);
    return () => window.removeEventListener("pointerdown", closeAvatarPicker);
  });

  async function saveBotPatch(updates: Omit<UpdateBotInput, "botId">): Promise<boolean> {
    setSaveError(null);
    try {
      await props.onUpdateBot(props.bot.id, updates);
      return true;
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Could not save agent settings.");
      return false;
    }
  }

  async function saveRuntimeSettings(
    settings: AgentRuntimeSettings,
    updates: AgentRuntimeSettingsPatch,
    botId = props.bot.id,
  ): Promise<boolean> {
    setSaveError(null);
    try {
      const saved = await props.onUpdateRuntimeSettings(botId, settings, updates);
      if (!saved && props.bot.id === botId) setSaveError("Could not save agent settings.");
      return saved;
    } catch (error) {
      if (props.bot.id === botId) {
        setSaveError(error instanceof Error ? error.message : "Could not save agent settings.");
      }
      return false;
    }
  }

  function saveName(): void {
    const botId = props.bot.id;
    const value = draft.fields.name.trim() || "New agent";
    setDraft((state) => {
      state.fields.name = value;
    });
    void saveBotPatch({ name: value }).then((saved) => {
      if (saved && props.bot.id === botId && draft.fields.name === value) {
        setDraft((state) => {
          state.dirty.name = false;
        });
      }
    });
  }

  function saveTitle(): void {
    const botId = props.bot.id;
    const value = draft.fields.title.trim();
    setDraft((state) => {
      state.fields.title = value;
    });
    void saveBotPatch({ title: value }).then((saved) => {
      if (saved && props.bot.id === botId && draft.fields.title === value) {
        setDraft((state) => {
          state.dirty.title = false;
        });
      }
    });
  }

  function saveDescription(): void {
    const botId = props.bot.id;
    const value = draft.fields.description;
    void saveBotPatch({ description: value }).then((saved) => {
      if (saved && props.bot.id === botId && draft.fields.description === value) {
        setDraft((state) => {
          state.dirty.description = false;
        });
      }
    });
  }

  async function setCustomAvatar(image: AvatarImageInput | null): Promise<boolean> {
    if (draft.avatar.uploadBusy) return false;
    setDraft((state) => {
      state.avatar.uploadBusy = true;
      state.saveError = null;
    });
    try {
      await props.onSetAgentAvatar(props.bot.id, image);
      return true;
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Could not save the agent avatar.");
      return false;
    } finally {
      setDraft((state) => {
        state.avatar.uploadBusy = false;
      });
    }
  }

  async function uploadAgentAvatar(file: File | undefined): Promise<void> {
    if (!file) return;
    setDraft((state) => {
      state.avatar.uploadBusy = true;
      state.saveError = null;
    });
    try {
      const image = await normalizeAvatarFile(file);
      await props.onSetAgentAvatar(props.bot.id, image);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Could not process the agent avatar.");
    } finally {
      setDraft((state) => {
        state.avatar.uploadBusy = false;
      });
      if (avatarFileInput) avatarFileInput.value = "";
    }
  }

  async function selectGeneratedAvatar(seed: string): Promise<void> {
    if (avatarUrl() && !(await setCustomAvatar(null))) return;
    setDraft((state) => {
      state.avatar.seed = seed;
    });
    await saveBotPatch({ avatarSeed: seed });
  }

  async function selectModel(nextModel: AgentModelId, nextProvider: AgentProviderId): Promise<void> {
    const option = props.modelOptions.find(
      (candidate) => candidate.provider === nextProvider && candidate.id === nextModel,
    );
    if (!option) return;
    // A plain copy, not `snapshot`: a snapshot of an unmodified subtree is the store's own object,
    // which the write below would mutate, leaving nothing to roll back to.
    const previous: AgentRuntimeSettings = {
      model: draft.runtime.model,
      provider: draft.runtime.provider,
      reasoningEffort: draft.runtime.reasoningEffort,
    };
    const botId = props.bot.id;
    const settings: AgentRuntimeSettings = {
      model: nextModel,
      provider: nextProvider,
      reasoningEffort: option.supportedReasoningEfforts.includes(previous.reasoningEffort)
        ? previous.reasoningEffort
        : option.defaultReasoningEffort,
    };
    setDraft((state) => {
      state.runtime.provider = settings.provider;
      state.runtime.model = settings.model;
      state.runtime.reasoningEffort = settings.reasoningEffort;
    });
    if (await saveRuntimeSettings(settings, settings, botId)) return;
    // Roll back only what this call wrote: another agent, or a later pick, owns the panel now.
    if (props.bot.id !== botId || !sameRuntimeSettings(draft.runtime, settings)) return;
    setDraft((state) => {
      state.runtime.provider = previous.provider;
      state.runtime.model = previous.model;
      state.runtime.reasoningEffort = previous.reasoningEffort;
    });
  }

  async function selectReasoning(nextReasoning: AgentReasoningEffort): Promise<void> {
    const botId = props.bot.id;
    const previousReasoning = draft.runtime.reasoningEffort;
    const settings: AgentRuntimeSettings = {
      model: draft.runtime.model,
      provider: draft.runtime.provider,
      reasoningEffort: nextReasoning,
    };
    setDraft((state) => {
      state.runtime.reasoningEffort = nextReasoning;
    });
    if (await saveRuntimeSettings(settings, { reasoningEffort: nextReasoning }, botId)) return;
    if (props.bot.id === botId && sameRuntimeSettings(draft.runtime, settings)) {
      setDraft((state) => {
        state.runtime.reasoningEffort = previousReasoning;
      });
    }
  }

  return (
    <aside id="settings-side-panel" class="agent-settings-panel" aria-label="Agent settings">
      <PanelResizer
        class="right-panel-resizer"
        label="Resize right panel"
        controls="settings-side-panel"
        direction="right"
        value={panelWidth()}
        defaultValue={SETTINGS_PANEL_DEFAULT}
        min={SETTINGS_PANEL_MIN}
        max={props.maxWidth}
        onResize={setPanelWidth}
        onResizeEnd={(value) => savePanelWidth(SETTINGS_PANEL_STORAGE_KEY, value)}
      />
      <Show when={!draft.routines.open}>
        <header class="agent-settings-header">
          <Button
            variant="ghost"
            type="button"
            class="agent-settings-nav-button"
            aria-label="Back to details"
            onClick={props.onClose}
          >
            <BackIcon />
          </Button>
          <h2>Settings</h2>
          <Button
            variant="ghost"
            type="button"
            class="agent-settings-nav-button"
            aria-label="Close details"
            onClick={props.onClose}
          >
            <SettingsForwardIcon />
          </Button>
        </header>
      </Show>
      <Show when={!draft.routines.open}>
        <div class="agent-settings-content">
          <div ref={(element) => (avatarPickerRoot = element)} class="agent-settings-avatar-picker">
            <Popover.Root
              open={draft.avatar.pickerOpen}
              placement="bottom"
              gutter={11}
              onOpenChange={(open) =>
                setDraft((state) => {
                  if (open) {
                    state.avatar.candidateSeed = state.avatar.seed;
                    state.avatar.batch = 0;
                  }
                  state.avatar.pickerOpen = open;
                })
              }
            >
              <Popover.Trigger class="agent-settings-avatar" aria-label="Edit agent avatar">
                <AgentAvatar seed={draft.avatar.seed} hue={draft.avatar.hue} url={avatarUrl()} motion="always" />
              </Popover.Trigger>
              <Popover.Content class="avatar-editor" aria-hidden={draft.avatar.pickerOpen ? undefined : "true"}>
                <Popover.Title class="sr-only">Avatar editor</Popover.Title>
                <Input
                  ref={(element) => (avatarFileInput = element)}
                  class="sr-only"
                  type="file"
                  aria-label="Attach files"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(event) => void uploadAgentAvatar(event.currentTarget.files?.[0])}
                />
                <div class="avatar-editor-heading">
                  <span>Image</span>
                  <div class="avatar-editor-actions">
                    <Show when={avatarUrl()}>
                      <Button
                        variant="outline"
                        type="button"
                        disabled={draft.avatar.uploadBusy}
                        onClick={() => void setCustomAvatar(null)}
                      >
                        Remove
                      </Button>
                    </Show>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  type="button"
                  class={["avatar-image-upload", { "avatar-image-upload-active": Boolean(avatarUrl()) }]}
                  disabled={draft.avatar.uploadBusy}
                  onClick={() => avatarFileInput?.click()}
                >
                  <span class="avatar-image-upload-preview">
                    <Show
                      when={avatarUrl()}
                      fallback={
                        <svg aria-hidden="true" viewBox="0 0 24 24">
                          <path d="M12 5v14M5 12h14" />
                        </svg>
                      }
                    >
                      <AgentAvatar seed={draft.avatar.seed} hue={draft.avatar.hue} url={avatarUrl()} />
                    </Show>
                  </span>
                  <span>
                    <strong>{avatarUrl() ? "Replace image" : "Upload image"}</strong>
                    <small>PNG, JPEG or WebP · square crop</small>
                  </span>
                </Button>
                <div class="avatar-editor-divider" />
                <div class="avatar-editor-heading">
                  <span>Generated face</span>
                  <div class="avatar-editor-actions">
                    <Show when={draft.avatar.seed !== props.bot.id}>
                      <Button
                        variant="outline"
                        type="button"
                        onClick={() => {
                          setDraft((state) => {
                            state.avatar.candidateSeed = props.bot.id;
                            state.avatar.batch = 0;
                          });
                          void selectGeneratedAvatar(props.bot.id);
                        }}
                      >
                        Reset to ID
                      </Button>
                    </Show>
                    <Button
                      variant="outline"
                      type="button"
                      onClick={() =>
                        setDraft((state) => {
                          state.avatar.candidateSeed = state.avatar.seed;
                          state.avatar.batch += 1;
                        })
                      }
                    >
                      New set
                    </Button>
                  </div>
                </div>
                <fieldset class="avatar-face-grid" aria-label="Generated avatar faces">
                  <For each={avatarCandidates()}>
                    {(seed, index) => (
                      <Button
                        variant="ghost"
                        type="button"
                        class={[
                          "avatar-face-choice",
                          { "avatar-choice-selected": !avatarUrl() && draft.avatar.seed === seed },
                        ]}
                        aria-label={
                          !avatarUrl() && draft.avatar.seed === seed
                            ? "Selected avatar"
                            : `Avatar option ${index() + 1}`
                        }
                        aria-pressed={!avatarUrl() && draft.avatar.seed === seed ? "true" : "false"}
                        onClick={() => void selectGeneratedAvatar(seed)}
                      >
                        <AgentAvatar seed={seed} hue={draft.avatar.hue} />
                      </Button>
                    )}
                  </For>
                </fieldset>
                <div class="avatar-editor-divider" />
                <div class="avatar-editor-heading">
                  <span>Color</span>
                </div>
                <fieldset class="avatar-color-grid" aria-label="Avatar color">
                  <Button
                    variant="ghost"
                    type="button"
                    class={["avatar-color-choice", { "avatar-choice-selected": draft.avatar.hue === null }]}
                    aria-label="Automatic avatar color"
                    aria-pressed={draft.avatar.hue === null ? "true" : "false"}
                    onClick={() => {
                      setDraft((state) => {
                        state.avatar.hue = null;
                      });
                      void saveBotPatch({ avatarHue: null });
                    }}
                  >
                    <span class="avatar-color-swatch avatar-color-swatch-auto">A</span>
                  </Button>
                  <For each={AVATAR_HUE_OPTIONS}>
                    {(option) => (
                      <Button
                        variant="ghost"
                        type="button"
                        class={["avatar-color-choice", { "avatar-choice-selected": draft.avatar.hue === option.hue }]}
                        aria-label={`${option.label} avatar color`}
                        aria-pressed={draft.avatar.hue === option.hue ? "true" : "false"}
                        onClick={() => {
                          setDraft((state) => {
                            state.avatar.hue = option.hue;
                          });
                          void saveBotPatch({ avatarHue: option.hue });
                        }}
                      >
                        <span class="avatar-color-swatch" style={{ background: avatarHueSwatch(option.hue) }} />
                      </Button>
                    )}
                  </For>
                </fieldset>
              </Popover.Content>
            </Popover.Root>
          </div>
          <label class="agent-settings-field">
            <span>Name</span>
            <Input
              value={draft.fields.name}
              aria-label="Agent name"
              maxlength={INPUT_LIMITS.agentName}
              onValueChange={(value) =>
                setDraft((state) => {
                  state.fields.name = value;
                  state.dirty.name = true;
                })
              }
              onBlur={saveName}
            />
          </label>
          <label class="agent-settings-field">
            <span>Title</span>
            <Input
              value={draft.fields.title}
              aria-label="Agent title"
              placeholder="Describe what your agent does"
              maxlength={INPUT_LIMITS.agentTitle}
              onValueChange={(value) =>
                setDraft((state) => {
                  state.fields.title = value;
                  state.dirty.title = true;
                })
              }
              onBlur={saveTitle}
            />
          </label>
          <label class="agent-settings-field agent-settings-description">
            <span>Description</span>
            <Textarea
              rows="4"
              value={draft.fields.description}
              aria-label="Agent description"
              placeholder="What this agent is for"
              maxlength={INPUT_LIMITS.agentDescription}
              onValueChange={(value) =>
                setDraft((state) => {
                  state.fields.description = value;
                  state.dirty.description = true;
                })
              }
              onBlur={saveDescription}
            />
          </label>
          <div class="agent-settings-links">
            <Button
              variant="ghost"
              type="button"
              class="agent-settings-link"
              onClick={() =>
                setDraft((state) => {
                  state.memories.open = true;
                })
              }
            >
              <span class="agent-settings-link-label">Memories</span>
              <span class="agent-settings-link-value">
                {draft.memories.count} saved
                <ChevronRight />
              </span>
            </Button>
            <Button
              variant="ghost"
              type="button"
              class="agent-settings-link"
              onClick={() =>
                setDraft((state) => {
                  state.routines.open = true;
                })
              }
            >
              <span class="agent-settings-link-label">Routines</span>
              <span class="agent-settings-link-value">
                {draft.routines.count} configured
                <ChevronRight />
              </span>
            </Button>
          </div>
          <section class="agent-settings-model" aria-labelledby="agent-model-heading">
            <div class="agent-settings-section-heading">
              <strong id="agent-model-heading">Runtime</strong>
              <span>Choose how this agent runs</span>
            </div>
            <div class="agent-settings-model-controls">
              <div class="agent-settings-model-option">
                <ProviderModelPicker
                  variant="field"
                  ariaLabel="Agent model"
                  provider={draft.runtime.provider}
                  value={draft.runtime.model}
                  agentStatus={props.agentStatus}
                  modelOptions={props.modelOptions}
                  runtimeStatuses={props.providerRuntimeStatuses}
                  onDownloadProvider={props.onDownloadProvider}
                  onCancelProviderDownload={props.onCancelProviderDownload}
                  onConnectProvider={props.onConnectProvider}
                  disabled={props.working}
                  disabledReason={
                    props.working
                      ? "Wait for the current work to finish before changing models."
                      : "Models are available after an agent CLI connects."
                  }
                  onChange={(nextModel, provider) => void selectModel(nextModel, provider)}
                />
              </div>
              <div class="agent-settings-model-row agent-settings-thinking-row">
                <span>Reasoning</span>
                <Select<AgentReasoningEffort>
                  class="agent-settings-reasoning-control"
                  options={reasoningOptions()}
                  value={draft.runtime.reasoningEffort}
                  onChange={(nextReasoning) => {
                    if (!nextReasoning || nextReasoning === draft.runtime.reasoningEffort) return;
                    void selectReasoning(nextReasoning);
                  }}
                  itemComponent={(item) => (
                    <SelectItem item={item.item}>{reasoningLabel(item.item.rawValue)}</SelectItem>
                  )}
                >
                  <SelectTrigger size="sm" class="agent-settings-reasoning-select" aria-label="Agent reasoning level">
                    <SelectValue<AgentReasoningEffort>>
                      {(state) => {
                        const effort = state.selectedOption();
                        return effort ? reasoningLabel(effort) : "Select reasoning";
                      }}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent />
                </Select>
              </div>
            </div>
          </section>
          <Show when={draft.saveError}>
            {(message) => (
              <p class="agent-settings-save-error" role="alert">
                {message()}
              </p>
            )}
          </Show>
          <div class="agent-settings-notifications">
            <div>
              <strong>Notifications</strong>
              <span>Get notified when this agent finishes or needs input</span>
            </div>
            <Switch
              size="sm"
              aria-label="Notifications"
              checked={draft.notifications}
              onChange={(next) => {
                setDraft((state) => {
                  state.notifications = next;
                });
                void saveBotPatch({ notifications: next });
              }}
            />
          </div>
        </div>
      </Show>
      <Show when={draft.routines.open}>
        <div class="agent-routines-overlay">
          <AgentRoutinesSettings
            botId={props.bot.id}
            onCountChange={(count) =>
              setDraft((state) => {
                state.routines.count = count;
              })
            }
            onBack={() =>
              setDraft((state) => {
                state.routines.open = false;
              })
            }
            onClose={props.onClose}
            selectionRequest={props.routineSelectionRequest}
            onSelectionRequestHandled={props.onRoutineSelectionRequestHandled}
            onOpenRun={props.onOpenRoutineRun}
          />
        </div>
      </Show>
      <AgentMemoriesModal
        botId={props.bot.id}
        botName={props.bot.name}
        open={draft.memories.open}
        onOpenChange={(open) =>
          setDraft((state) => {
            state.memories.open = open;
          })
        }
        onCountChange={(count) =>
          setDraft((state) => {
            state.memories.count = count;
          })
        }
      />
    </aside>
  );
}

/** True when the panel still shows exactly the settings a save was issued for. */
function sameRuntimeSettings(current: AgentRuntimeSettings, settings: AgentRuntimeSettings): boolean {
  return (
    current.provider === settings.provider &&
    current.model === settings.model &&
    current.reasoningEffort === settings.reasoningEffort
  );
}

function reasoningLabel(effort: AgentReasoningEffort): string {
  if (effort === "xhigh") return "Extra high";
  return `${effort.slice(0, 1).toUpperCase()}${effort.slice(1)}`;
}
