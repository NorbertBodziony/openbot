import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  AgentModelId,
  AgentModelOption,
  AgentReasoningEffort,
  AgentStatus,
  AvatarImageInput,
  BotAvatarHue,
  UpdateBotInput,
} from "@openbot/contracts/ipc";
import { createEffect, createMemo, createSignal, For, onSettled, Show } from "solid-js";
import { normalizeAvatarFile } from "../../avatar-image";
import { AVATAR_HUE_OPTIONS, avatarCandidateSeeds, avatarHueSwatch } from "../../bloub-avatar";
import type { BotProfile } from "../../data";
import { AgentAvatar } from "../AgentAvatar";
import { PanelResizer, readPanelWidth, savePanelWidth } from "../PanelResizer";
import { ProviderModelPicker } from "../ProviderModelPicker";
import {
  Button,
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
import { BackIcon, SettingsForwardIcon } from "./ConversationIcons";

const SETTINGS_PANEL_STORAGE_KEY = "openbot:settings-panel-width";
const SETTINGS_PANEL_DEFAULT = 296;
const SETTINGS_PANEL_MIN = 180;
const SETTINGS_PANEL_MAX = 1600;

interface AgentSettingsPanelProps {
  bot: BotProfile;
  agentStatus: AgentStatus;
  modelOptions: AgentModelOption[];
  working: boolean;
  maxWidth: () => number;
  onClose: () => void;
  onWidthChange: (width: number) => void;
  onUpdateBot: (botId: string, updates: Omit<UpdateBotInput, "botId">) => Promise<void>;
  onSetAgentAvatar: (botId: string, image: AvatarImageInput | null) => Promise<void>;
}

export default function AgentSettingsPanel(props: AgentSettingsPanelProps) {
  const [panelWidth, setPanelWidth] = createSignal(
    readPanelWidth(SETTINGS_PANEL_STORAGE_KEY, SETTINGS_PANEL_DEFAULT, SETTINGS_PANEL_MIN, SETTINGS_PANEL_MAX),
  );
  const [saveError, setSaveError] = createSignal<string | null>(null);
  const [name, setName] = createSignal("");
  const [title, setTitle] = createSignal("");
  const [description, setDescription] = createSignal("");
  const [dirty, setDirty] = createSignal({ name: false, title: false, description: false });
  const [notifications, setNotifications] = createSignal(true);
  const [model, setModel] = createSignal<AgentModelId>("gpt-5.6-luna");
  const [reasoning, setReasoning] = createSignal<AgentReasoningEffort>("medium");
  const [avatarPickerOpen, setAvatarPickerOpen] = createSignal(false);
  const [avatarSeed, setAvatarSeed] = createSignal("agent");
  const [avatarHue, setAvatarHue] = createSignal<BotAvatarHue | null>(null);
  const [avatarUploadBusy, setAvatarUploadBusy] = createSignal(false);
  const [avatarCandidateSeed, setAvatarCandidateSeed] = createSignal("agent");
  const [avatarBatch, setAvatarBatch] = createSignal(0);
  const avatarUrl = () => props.bot.avatarUrl ?? null;
  const selectedModel = createMemo(() => props.modelOptions.find((option) => option.id === model()));
  const reasoningOptions = createMemo(() => selectedModel()?.supportedReasoningEfforts ?? ["medium" as const]);
  const avatarCandidates = createMemo(() => avatarCandidateSeeds(props.bot.id, avatarCandidateSeed(), avatarBatch()));
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
      return {
        bot,
        signature: [
          bot.id,
          bot.name,
          bot.title,
          bot.description,
          String(bot.notifications),
          bot.model,
          bot.reasoningEffort,
          bot.avatarSeed,
          String(bot.avatarHue),
        ].join("\u0000"),
      };
    },
    ({ bot, signature }) => {
      if (signature === lastSignature) return;
      const botChanged = bot.id !== lastBotId;
      const currentDirty = botChanged ? { name: false, title: false, description: false } : dirty();
      lastSignature = signature;
      lastBotId = bot.id;
      if (botChanged) setDirty(currentDirty);
      if (!currentDirty.name) setName(bot.name);
      if (!currentDirty.title) setTitle(bot.title);
      if (!currentDirty.description) setDescription(bot.description);
      setNotifications(bot.notifications);
      setModel(bot.model);
      setReasoning(bot.reasoningEffort);
      setAvatarSeed(bot.avatarSeed);
      setAvatarHue(bot.avatarHue);
      if (botChanged) {
        setAvatarCandidateSeed(bot.avatarSeed);
        setAvatarBatch(0);
        setAvatarPickerOpen(false);
      }
    },
  );

  onSettled(() => {
    const closeAvatarPicker = (event: PointerEvent) => {
      if (!avatarPickerOpen()) return;
      if (event.target instanceof Node && avatarPickerRoot?.contains(event.target)) return;
      setAvatarPickerOpen(false);
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

  function saveName(): void {
    const botId = props.bot.id;
    const value = name().trim() || "New agent";
    setName(value);
    void saveBotPatch({ name: value }).then((saved) => {
      if (saved && props.bot.id === botId && name() === value) {
        setDirty((current) => ({ ...current, name: false }));
      }
    });
  }

  function saveTitle(): void {
    const botId = props.bot.id;
    const value = title().trim();
    setTitle(value);
    void saveBotPatch({ title: value }).then((saved) => {
      if (saved && props.bot.id === botId && title() === value) {
        setDirty((current) => ({ ...current, title: false }));
      }
    });
  }

  function saveDescription(): void {
    const botId = props.bot.id;
    const value = description();
    void saveBotPatch({ description: value }).then((saved) => {
      if (saved && props.bot.id === botId && description() === value) {
        setDirty((current) => ({ ...current, description: false }));
      }
    });
  }

  async function setCustomAvatar(image: AvatarImageInput | null): Promise<boolean> {
    if (avatarUploadBusy()) return false;
    setAvatarUploadBusy(true);
    setSaveError(null);
    try {
      await props.onSetAgentAvatar(props.bot.id, image);
      return true;
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Could not save the agent avatar.");
      return false;
    } finally {
      setAvatarUploadBusy(false);
    }
  }

  async function uploadAgentAvatar(file: File | undefined): Promise<void> {
    if (!file) return;
    setAvatarUploadBusy(true);
    setSaveError(null);
    try {
      const image = await normalizeAvatarFile(file);
      await props.onSetAgentAvatar(props.bot.id, image);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Could not process the agent avatar.");
    } finally {
      setAvatarUploadBusy(false);
      if (avatarFileInput) avatarFileInput.value = "";
    }
  }

  async function selectGeneratedAvatar(seed: string): Promise<void> {
    if (avatarUrl() && !(await setCustomAvatar(null))) return;
    setAvatarSeed(seed);
    await saveBotPatch({ avatarSeed: seed });
  }

  async function selectModel(nextModel: AgentModelId): Promise<void> {
    const option = props.modelOptions.find((candidate) => candidate.id === nextModel);
    if (!option) return;
    const nextReasoning = option.supportedReasoningEfforts.includes(reasoning())
      ? reasoning()
      : option.defaultReasoningEffort;
    const previousModel = model();
    const previousReasoning = reasoning();
    setModel(nextModel);
    setReasoning(nextReasoning);
    if (await saveBotPatch({ model: nextModel, reasoningEffort: nextReasoning })) return;
    setModel(previousModel);
    setReasoning(previousReasoning);
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
      <header class="agent-settings-header">
        <Button type="button" class="agent-settings-nav-button" aria-label="Back to details" onClick={props.onClose}>
          <BackIcon />
        </Button>
        <h2>Settings</h2>
        <Button type="button" class="agent-settings-nav-button" aria-label="Close details" onClick={props.onClose}>
          <SettingsForwardIcon />
        </Button>
      </header>
      <div class="agent-settings-content">
        <div ref={(element) => (avatarPickerRoot = element)} class="agent-settings-avatar-picker">
          <Popover.Root
            open={avatarPickerOpen()}
            placement="bottom"
            gutter={11}
            onOpenChange={(open) => {
              if (open) {
                setAvatarCandidateSeed(avatarSeed());
                setAvatarBatch(0);
              }
              setAvatarPickerOpen(open);
            }}
          >
            <Popover.Trigger class="agent-settings-avatar" aria-label="Edit agent avatar">
              <AgentAvatar seed={avatarSeed()} hue={avatarHue()} url={avatarUrl()} motion="always" />
            </Popover.Trigger>
            <Popover.Content class="avatar-editor" aria-hidden={avatarPickerOpen() ? undefined : "true"}>
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
                    <Button type="button" disabled={avatarUploadBusy()} onClick={() => void setCustomAvatar(null)}>
                      Remove
                    </Button>
                  </Show>
                </div>
              </div>
              <Button
                type="button"
                class={["avatar-image-upload", { "avatar-image-upload-active": Boolean(avatarUrl()) }]}
                disabled={avatarUploadBusy()}
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
                    <AgentAvatar seed={avatarSeed()} hue={avatarHue()} url={avatarUrl()} />
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
                  <Show when={avatarSeed() !== props.bot.id}>
                    <Button
                      type="button"
                      onClick={() => {
                        setAvatarCandidateSeed(props.bot.id);
                        setAvatarBatch(0);
                        void selectGeneratedAvatar(props.bot.id);
                      }}
                    >
                      Reset to ID
                    </Button>
                  </Show>
                  <Button
                    type="button"
                    onClick={() => {
                      setAvatarCandidateSeed(avatarSeed());
                      setAvatarBatch((batch) => batch + 1);
                    }}
                  >
                    New set
                  </Button>
                </div>
              </div>
              <fieldset class="avatar-face-grid" aria-label="Generated avatar faces">
                <For each={avatarCandidates()}>
                  {(seed, index) => (
                    <Button
                      type="button"
                      class={[
                        "avatar-face-choice",
                        { "avatar-choice-selected": !avatarUrl() && avatarSeed() === seed },
                      ]}
                      aria-label={
                        !avatarUrl() && avatarSeed() === seed ? "Selected avatar" : `Avatar option ${index() + 1}`
                      }
                      aria-pressed={!avatarUrl() && avatarSeed() === seed ? "true" : "false"}
                      onClick={() => void selectGeneratedAvatar(seed)}
                    >
                      <AgentAvatar seed={seed} hue={avatarHue()} />
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
                  type="button"
                  class={["avatar-color-choice", { "avatar-choice-selected": avatarHue() === null }]}
                  aria-label="Automatic avatar color"
                  aria-pressed={avatarHue() === null ? "true" : "false"}
                  onClick={() => {
                    setAvatarHue(null);
                    void saveBotPatch({ avatarHue: null });
                  }}
                >
                  <span class="avatar-color-swatch avatar-color-swatch-auto">A</span>
                </Button>
                <For each={AVATAR_HUE_OPTIONS}>
                  {(option) => (
                    <Button
                      type="button"
                      class={["avatar-color-choice", { "avatar-choice-selected": avatarHue() === option.hue }]}
                      aria-label={`${option.label} avatar color`}
                      aria-pressed={avatarHue() === option.hue ? "true" : "false"}
                      onClick={() => {
                        setAvatarHue(option.hue);
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
            value={name()}
            aria-label="Agent name"
            maxlength={INPUT_LIMITS.agentName}
            onValueChange={(value) => {
              setName(value);
              setDirty((current) => ({ ...current, name: true }));
            }}
            onBlur={saveName}
          />
        </label>
        <label class="agent-settings-field">
          <span>Title</span>
          <Input
            value={title()}
            aria-label="Agent title"
            placeholder="Describe what your agent does"
            maxlength={INPUT_LIMITS.agentTitle}
            onValueChange={(value) => {
              setTitle(value);
              setDirty((current) => ({ ...current, title: true }));
            }}
            onBlur={saveTitle}
          />
        </label>
        <label class="agent-settings-field agent-settings-description">
          <span>Description</span>
          <Textarea
            rows="4"
            value={description()}
            aria-label="Agent description"
            placeholder="What this agent is for"
            maxlength={INPUT_LIMITS.agentDescription}
            onValueChange={(value) => {
              setDescription(value);
              setDirty((current) => ({ ...current, description: true }));
            }}
            onBlur={saveDescription}
          />
        </label>
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
                value={model()}
                agentStatus={props.agentStatus}
                modelOptions={props.modelOptions}
                disabled={props.agentStatus.phase !== "ready" || props.working}
                disabledReason={
                  props.working
                    ? "Wait for the current work to finish before changing models."
                    : "Models are available after an agent CLI connects."
                }
                onChange={(nextModel) => void selectModel(nextModel)}
              />
            </div>
            <div class="agent-settings-model-row agent-settings-thinking-row">
              <span>Reasoning</span>
              <Select<AgentReasoningEffort>
                class="agent-settings-reasoning-control"
                options={reasoningOptions()}
                value={reasoning()}
                onChange={(nextReasoning) => {
                  if (!nextReasoning) return;
                  setReasoning(nextReasoning);
                  void saveBotPatch({ reasoningEffort: nextReasoning });
                }}
                itemComponent={(item) => <SelectItem item={item.item}>{reasoningLabel(item.item.rawValue)}</SelectItem>}
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
        <Show when={saveError()}>
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
            checked={notifications()}
            onChange={(next) => {
              setNotifications(next);
              void saveBotPatch({ notifications: next });
            }}
          />
        </div>
      </div>
    </aside>
  );
}

function reasoningLabel(effort: AgentReasoningEffort): string {
  if (effort === "xhigh") return "Extra high";
  return `${effort.slice(0, 1).toUpperCase()}${effort.slice(1)}`;
}
