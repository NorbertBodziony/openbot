import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  AccountSession,
  AgentProviderId,
  AgentStatus,
  AppInfo,
  AvatarImageInput,
  CentralAuthUser,
  HostedSiteSummary,
  HostedSitesDesktopApi,
  MobileConnectedDevice,
  MobileConnectTicket,
  ProviderRuntimeStatus,
  UpdateStatus,
} from "@openbot/contracts/ipc";
import { isUpdateActivePhase } from "@openbot/contracts/ipc";
import { normalizeAccountName, validateProfileName } from "@openbot/contracts/validation";
import { createEffect, createMemo, createSignal, createStore, For, onCleanup, Show } from "solid-js";
import { desktopAnalytics } from "../analytics";
import type { GeneralSettingsValue } from "../app-settings";
import { normalizeAvatarFile } from "../avatar-image";
import { presentUpdateStatus } from "../features/updates/update-status";
import { ComputerUseMacSetup } from "./ComputerUseMacSetup";
import { ProviderPicker, type ProviderPickerOption } from "./ProviderPicker";
import { SettingsDialogShell } from "./SettingsDialogShell";
import {
  Alert,
  AlertContent,
  AlertDescription,
  AlertIcon,
  AlertTitle,
  Badge,
  Button,
  CircleArrowDown,
  CircleCheck,
  ExternalLink,
  Globe2,
  ImageRemoveButton,
  Info,
  Input,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
  MousePointer2,
  QrCode,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Settings,
  SettingsSection,
  Smartphone,
  SwitchField,
  Tabs,
  Text,
  Trash2,
  UserAvatar,
  UserRound,
} from "./ui";

export interface SettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: GeneralSettingsValue;
  onValueChange: (value: GeneralSettingsValue) => void;
  appInfo: AppInfo | null;
  updateStatus: UpdateStatus;
  onUpdateAction: () => Promise<void>;
  account: CentralAuthUser;
  onUpdateAccountName: (name: string) => Promise<void>;
  onUpdateAccountAvatar: (image: AvatarImageInput | null) => Promise<void>;
  onCreateMobileConnect?: () => Promise<MobileConnectTicket>;
  onListMobileConnectedDevices?: () => Promise<MobileConnectedDevice[]>;
  onRevokeMobileConnectedDevice?: (sessionId: string) => Promise<void>;
  onListAccountSessions?: () => Promise<AccountSession[]>;
  onRevokeAccountSession?: (sessionId: string) => Promise<void>;
  processAvatarFile?: (file: File) => Promise<AvatarImageInput>;
  agentStatus?: AgentStatus;
  providerRuntimeStatuses?: Partial<Record<AgentProviderId, ProviderRuntimeStatus>>;
  onDownloadProvider?: (provider: AgentProviderId) => void | Promise<void>;
  onCancelProviderDownload?: (provider: AgentProviderId) => void | Promise<void>;
  onConnectProvider?: (provider: AgentProviderId) => void | Promise<void>;
  hostedSitesApi?: HostedSitesDesktopApi;
  restoreFocusTarget?: HTMLElement | null;
}

type SettingsTab = "general" | "computer-use" | "profile" | "mobile-connect" | "updates" | "hosted-sites";

type SettingsNavItem = { value: SettingsTab; label: string; icon: typeof Settings };

const navItems: ReadonlyArray<SettingsNavItem> = [
  { value: "general", label: "General", icon: Settings },
  { value: "computer-use", label: "Computer Use", icon: MousePointer2 },
  { value: "profile", label: "Profile", icon: UserRound },
  { value: "mobile-connect", label: "Mobile Connect", icon: Smartphone },
  { value: "updates", label: "Updates", icon: CircleArrowDown },
  { value: "hosted-sites", label: "Hosted sites", icon: Globe2 },
];

const tabDetails: Record<SettingsTab, { title: string; description: string }> = {
  general: { title: "General", description: "Control how OpenBot behaves on this computer." },
  "computer-use": {
    title: "Computer Use",
    description: "Allow OpenBot to see and interact with apps on this Mac.",
  },
  profile: { title: "Profile", description: "Manage how you appear in OpenBot." },
  "mobile-connect": { title: "Mobile Connect", description: "Sign in securely on your phone." },
  updates: { title: "Updates", description: "Keep OpenBot current on this computer." },
  "hosted-sites": { title: "Hosted sites", description: "View and manage static sites published by your agents." },
};

interface ProfileNameEdit {
  busy: boolean;
  name: string;
  saveError: string | null;
  savedName: string;
  touched: boolean;
}

interface AvatarUpload {
  busy: boolean;
  error: string | null;
}

/** A generated Mobile Connect code, from the moment it is displayed until it is cleared. */
interface MobileConnectSession {
  /** True while the success banner plays its collapse animation. */
  collapsing: boolean;
  /**
   * When this code became able to pair a phone. Null while a replacement code is being generated:
   * the code on screen is still the old one, and a device that appears now is not its doing.
   */
  startedAt: number | null;
  successDeviceName: string | null;
  ticket: MobileConnectTicket;
}

interface MobileConnectPanel {
  busy: boolean;
  error: string | null;
  /** Carries `startedAt`, so neither can exist without the other. */
  session: MobileConnectSession | null;
}

interface MobileDeviceList {
  devices: MobileConnectedDevice[];
  error: string | null;
  /** Stays true across a refresh, so the list keeps rendering while `loading` is also true. */
  loaded: boolean;
  loading: boolean;
  revokingSessionId: string | null;
}

interface HostedSitesPanel {
  busy: boolean;
  error: string | null;
  sites: HostedSiteSummary[];
}

/**
 * One record per panel of the dialog. Each group's fields are written together — a save touches
 * the draft, its error and its busy flag at once — so they are one store rather than a signal
 * each, and replacing one field re-renders only what read that field.
 */
interface SettingsPanels {
  avatar: AvatarUpload;
  connect: MobileConnectPanel;
  devices: MobileDeviceList;
  hosting: HostedSitesPanel;
  profile: ProfileNameEdit;
  sessions: { items: AccountSession[]; loading: boolean; error: string | null; revokingId: string | null };
}

const linkTargetOptions: GeneralSettingsValue["externalLinkTarget"][] = ["Default browser", "OpenBot"];
type UpdateTrack = "Stable";
const updateTrackOptions: UpdateTrack[] = ["Stable"];
const MOBILE_CONNECT_SUCCESS_FEEDBACK_MS = 900;
const MOBILE_CONNECT_COLLAPSE_MS = 240;
const MOBILE_DEVICES_REFRESH_INTERVAL_MS = 60_000;
const MOBILE_CONNECT_PENDING_REFRESH_INTERVAL_MS = 5_000;

export function SettingsModal(props: SettingsModalProps) {
  const [panels, setPanels] = createStore<SettingsPanels>({
    avatar: { busy: false, error: null },
    connect: { busy: false, error: null, session: null },
    devices: { devices: [], error: null, loaded: false, loading: false, revokingSessionId: null },
    hosting: { busy: false, error: null, sites: [] },
    profile: { busy: false, name: "", saveError: null, savedName: "", touched: false },
    sessions: { items: [], loading: false, error: null, revokingId: null },
  });
  const [activeTab, setActiveTab] = createSignal<SettingsTab>("general");
  const [selectedProvider, setSelectedProvider] = createSignal<AgentProviderId | null>(null);
  const [updateError, setUpdateError] = createSignal<string | null>(null);
  /** A clock, not panel state: it ticks the code's countdown and the device list's "3m ago" labels. */
  const [mobileNow, setMobileNow] = createSignal(Date.now());
  let modalElement: HTMLElement | undefined;
  let avatarFileInput: HTMLInputElement | undefined;
  let profileNameInput: HTMLInputElement | undefined;
  let hostedSitesReloadRequested = false;
  let hostedSitesLoadPromise: Promise<void> | null = null;
  let mobileDevicesRequestRevision = 0;
  let accountSessionsRevision = 0;
  let mobileConnectBaselineSessionIds = new Set<string>();
  let mobileConnectSuccessTimer: number | undefined;
  let mobileConnectCleanupTimer: number | undefined;

  const accountName = () => props.account.name?.trim() || props.account.email.split("@")[0] || props.account.email;

  async function refreshAccountSessions() {
    if (!props.onListAccountSessions) return;
    const revision = ++accountSessionsRevision;
    setPanels((state) => {
      state.sessions.loading = true;
      state.sessions.error = null;
    });
    try {
      const items = await props.onListAccountSessions();
      if (revision !== accountSessionsRevision) return;
      setPanels((state) => {
        state.sessions.items = items;
      });
    } catch {
      if (revision !== accountSessionsRevision) return;
      setPanels((state) => {
        state.sessions.error = "Could not load account sessions. Please try again.";
      });
    } finally {
      if (revision === accountSessionsRevision)
        setPanels((state) => {
          state.sessions.loading = false;
        });
    }
  }

  async function revokeAccountSession(sessionId: string) {
    if (!props.onRevokeAccountSession || panels.sessions.revokingId) return;
    const revision = accountSessionsRevision;
    setPanels((state) => {
      state.sessions.revokingId = sessionId;
      state.sessions.error = null;
    });
    try {
      await props.onRevokeAccountSession(sessionId);
      if (revision !== accountSessionsRevision) return;
      await refreshAccountSessions();
    } catch {
      if (revision !== accountSessionsRevision) return;
      setPanels((state) => {
        state.sessions.error = "Could not disconnect this session. Please try again.";
      });
    } finally {
      setPanels((state) => {
        if (state.sessions.revokingId === sessionId) state.sessions.revokingId = null;
      });
    }
  }

  createEffect(
    () => ({ open: props.open, tab: activeTab(), accountId: props.account.id, list: props.onListAccountSessions }),
    ({ open, tab, list }) => {
      accountSessionsRevision += 1;
      setPanels((state) => {
        state.sessions.items = [];
        state.sessions.revokingId = null;
      });
      if (open && tab === "profile" && list) void refreshAccountSessions();
      return () => {
        accountSessionsRevision += 1;
      };
    },
  );

  createEffect(
    () => props.account.name,
    () => {
      const name = accountName();
      setPanels((state) => {
        state.profile.savedName = normalizeAccountName(name);
        state.profile.name = name;
        state.profile.touched = false;
        state.profile.saveError = null;
      });
    },
  );

  createEffect(
    () => ({
      open: props.open,
      active: activeTab() === "mobile-connect",
      list: props.onListMobileConnectedDevices,
      ticketExpiresAt: panels.connect.session?.ticket.expiresAt ?? null,
    }),
    ({ open, active, list }) => {
      mobileDevicesRequestRevision += 1;
      if (!open || !active || !list) return;
      let running = true;
      let timer: number | undefined;

      const scheduleRefresh = () => {
        const ticket = panels.connect.session?.ticket;
        const refreshInterval =
          ticket && ticket.expiresAt > Date.now()
            ? MOBILE_CONNECT_PENDING_REFRESH_INTERVAL_MS
            : MOBILE_DEVICES_REFRESH_INTERVAL_MS;
        timer = window.setTimeout(async () => {
          await refreshMobileDevices(false);
          if (running) scheduleRefresh();
        }, refreshInterval);
      };

      void refreshMobileDevices(true);
      scheduleRefresh();
      return () => {
        running = false;
        mobileDevicesRequestRevision += 1;
        if (timer !== undefined) window.clearTimeout(timer);
      };
    },
  );

  const profileNameValidation = createMemo(() => validateProfileName(panels.profile.name));
  const normalizedProfileName = () => profileNameValidation().name;
  const profileNameError = () => {
    switch (profileNameValidation().error) {
      case "unsafe":
        return "Remove line breaks and hidden or control characters.";
      case "required":
        return "Enter a display name.";
      case "too-short":
        return `Use at least ${INPUT_LIMITS.profileNameMin} characters.`;
      case "too-long":
        return `Use no more than ${INPUT_LIMITS.profileName} characters.`;
      case null:
        return null;
    }
  };
  const visibleProfileNameError = () =>
    panels.profile.saveError ?? (panels.profile.touched ? profileNameError() : null);
  const profileNameDirty = () => normalizedProfileName() !== panels.profile.savedName;
  const mobileConnectSecondsRemaining = createMemo(() =>
    Math.max(0, Math.ceil(((panels.connect.session?.ticket.expiresAt ?? 0) - mobileNow()) / 1_000)),
  );
  const mobileConnectExpired = () => Boolean(panels.connect.session && mobileConnectSecondsRemaining() === 0);
  const mobileConnectExpiryLabel = () => {
    const seconds = mobileConnectSecondsRemaining();
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
  };

  createEffect(
    () => ({ open: props.open, ticket: panels.connect.session?.ticket ?? null }),
    ({ open, ticket }) => {
      if (!open || !ticket) return;
      setMobileNow(Date.now());
      const timer = window.setInterval(() => setMobileNow(Date.now()), 1_000);
      return () => window.clearInterval(timer);
    },
  );

  const title = () => tabDetails[activeTab()].title;
  const description = () => tabDetails[activeTab()].description;
  const updatePresentation = createMemo(() => presentUpdateStatus(props.updateStatus));
  const installedVersion = () => props.updateStatus.currentVersion || props.appInfo?.version || "Unknown";
  const targetUpdate = () =>
    props.updateStatus.availableVersion
      ? `OpenBot v${props.updateStatus.availableVersion}`
      : "The latest OpenBot update";
  const updateMessage = () => {
    if (updateError()) return updateError();
    switch (props.updateStatus.phase) {
      case "idle":
        return "Check for updates to find the latest Stable release.";
      case "checking":
        return "Checking the Stable track for updates…";
      case "available":
        return `${targetUpdate()} is available to download.`;
      case "downloading":
        return `Downloading ${targetUpdate()}${
          props.updateStatus.progress === null ? "…" : ` · ${Math.round(props.updateStatus.progress)}%`
        }`;
      case "ready":
        return `${targetUpdate()} is ready. Restart to apply.`;
      case "installing":
        return `Restarting to apply ${targetUpdate()}…`;
      case "up-to-date":
        return "OpenBot is up to date on the Stable track.";
      case "error":
        return props.updateStatus.message ?? "OpenBot could not check for updates.";
      case "unsupported":
        return props.updateStatus.message ?? "Updates are unavailable in this build.";
    }
  };
  const updateMessageClass = () => {
    if (updateError() || props.updateStatus.phase === "error")
      return "settings-modal-update-status settings-modal-error";
    if (isUpdateActivePhase(props.updateStatus.phase)) {
      return "settings-modal-update-status settings-modal-update-status-active";
    }
    return "settings-modal-update-status";
  };
  const providerOptions = createMemo<ProviderPickerOption[]>(() =>
    (["codex", "claude", "grok"] as const).map((provider) => {
      const agent = props.agentStatus?.providers?.find((candidate) => candidate.id === provider);
      const runtime = props.providerRuntimeStatuses?.[provider];
      return {
        id: provider,
        name: provider === "codex" ? "ChatGPT" : provider === "claude" ? "Claude" : "Grok",
        description: "Available on this computer",
        state: agent?.state ?? "not-installed",
        message: agent?.message,
        email: agent?.email,
        connectionState: agent?.connectionState,
        checkError: agent?.checkError,
        runtimeStatus:
          runtime?.phase === "not-downloaded" && (agent?.state === "available" || agent?.state === "sign-in-required")
            ? { ...runtime, phase: "ready", version: agent.version ?? null }
            : runtime,
      };
    }),
  );
  const tabsProps = {
    get value() {
      return activeTab();
    },
    onChange(value: string) {
      if (
        value === "general" ||
        value === "computer-use" ||
        value === "profile" ||
        value === "mobile-connect" ||
        value === "updates" ||
        value === "hosted-sites"
      ) {
        setActiveTab(value);
      }
    },
    orientation: "vertical" as const,
    activationMode: "automatic" as const,
  };

  function updateSetting<Key extends keyof GeneralSettingsValue>(key: Key, value: GeneralSettingsValue[Key]): void {
    props.onValueChange({ ...props.value, [key]: value });
  }

  async function runUpdateAction(): Promise<void> {
    if (updatePresentation().busy || !updatePresentation().supported) return;
    setUpdateError(null);
    try {
      await props.onUpdateAction();
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : "Could not update OpenBot.");
    }
  }

  async function createMobileConnect(): Promise<void> {
    if (panels.connect.busy || !props.onCreateMobileConnect) return;
    clearMobileConnectFeedbackTimers();
    setPanels((state) => {
      state.connect.busy = true;
      state.connect.error = null;
      // The old code stays on screen while the new one is generated, but stops being able to pair.
      if (state.connect.session) {
        state.connect.session.collapsing = false;
        state.connect.session.startedAt = null;
        state.connect.session.successDeviceName = null;
      }
    });
    try {
      let baselineDevices = panels.devices.devices;
      if (props.onListMobileConnectedDevices) {
        const refreshedDevices = await refreshMobileDevices(true);
        if (!refreshedDevices) {
          throw new Error(panels.devices.error ?? "Could not load connected devices before generating a code.");
        }
        baselineDevices = refreshedDevices;
      }
      mobileConnectBaselineSessionIds = new Set(baselineDevices.map((device) => device.sessionId));
      const ticket = await props.onCreateMobileConnect();
      const now = Date.now();
      setPanels((state) => {
        state.connect.session = { collapsing: false, startedAt: now, successDeviceName: null, ticket };
      });
      setMobileNow(now);
    } catch (error) {
      setPanels((state) => {
        state.connect.session = null;
        state.connect.error = error instanceof Error ? error.message : "Could not generate a Mobile Connect code.";
      });
    } finally {
      setPanels((state) => {
        state.connect.busy = false;
      });
    }
  }

  async function refreshMobileDevices(showLoading: boolean): Promise<MobileConnectedDevice[] | null> {
    const list = props.onListMobileConnectedDevices;
    if (!list || panels.devices.revokingSessionId) return null;
    const revision = ++mobileDevicesRequestRevision;
    if (showLoading)
      setPanels((state) => {
        state.devices.loading = true;
      });
    try {
      const devices = await list();
      if (revision !== mobileDevicesRequestRevision) return null;
      const connectedDevice = newlyConnectedMobileDevice(devices);
      setPanels((state) => {
        state.devices.devices = devices;
        state.devices.loaded = true;
        state.devices.error = null;
      });
      setMobileNow(Date.now());
      if (connectedDevice) showMobileConnectSuccess(connectedDevice);
      return devices;
    } catch (error) {
      if (revision !== mobileDevicesRequestRevision) return null;
      setPanels((state) => {
        state.devices.error = error instanceof Error ? error.message : "Could not load connected devices.";
      });
      return null;
    } finally {
      if (revision === mobileDevicesRequestRevision)
        setPanels((state) => {
          state.devices.loading = false;
        });
    }
  }

  function newlyConnectedMobileDevice(devices: MobileConnectedDevice[]): MobileConnectedDevice | null {
    const session = panels.connect.session;
    const startedAt = session?.startedAt;
    if (
      !session ||
      startedAt === null ||
      startedAt === undefined ||
      session.successDeviceName ||
      Date.now() > session.ticket.expiresAt + 5_000
    ) {
      return null;
    }
    return (
      devices.find(
        (device) =>
          !mobileConnectBaselineSessionIds.has(device.sessionId) &&
          (panels.devices.loaded || device.connectedAt >= startedAt - 5_000),
      ) ?? null
    );
  }

  function showMobileConnectSuccess(device: MobileConnectedDevice): void {
    clearMobileConnectFeedbackTimers();
    setPanels((state) => {
      if (state.connect.session) state.connect.session.successDeviceName = device.name;
    });
    mobileConnectSuccessTimer = window.setTimeout(() => {
      setPanels((state) => {
        if (state.connect.session) state.connect.session.collapsing = true;
      });
      mobileConnectCleanupTimer = window.setTimeout(() => {
        setPanels((state) => {
          state.connect.session = null;
        });
      }, MOBILE_CONNECT_COLLAPSE_MS);
    }, MOBILE_CONNECT_SUCCESS_FEEDBACK_MS);
  }

  function clearMobileConnectFeedbackTimers(): void {
    if (mobileConnectSuccessTimer !== undefined) window.clearTimeout(mobileConnectSuccessTimer);
    if (mobileConnectCleanupTimer !== undefined) window.clearTimeout(mobileConnectCleanupTimer);
    mobileConnectSuccessTimer = undefined;
    mobileConnectCleanupTimer = undefined;
  }

  onCleanup(clearMobileConnectFeedbackTimers);

  async function revokeMobileDevice(device: MobileConnectedDevice): Promise<void> {
    if (!props.onRevokeMobileConnectedDevice || panels.devices.revokingSessionId) return;
    mobileDevicesRequestRevision += 1;
    setPanels((state) => {
      state.devices.loading = false;
      state.devices.revokingSessionId = device.sessionId;
      state.devices.error = null;
    });
    try {
      await props.onRevokeMobileConnectedDevice(device.sessionId);
      setPanels((state) => {
        state.devices.devices = state.devices.devices.filter((candidate) => candidate.sessionId !== device.sessionId);
      });
    } catch (error) {
      setPanels((state) => {
        state.devices.error = error instanceof Error ? error.message : "Could not disconnect this device.";
      });
    } finally {
      setPanels((state) => {
        state.devices.revokingSessionId = null;
      });
    }
  }

  function mobileDevicePlatformLabel(platform: MobileConnectedDevice["platform"]): "iOS" | "Android" | "Mobile" {
    if (platform === "ios") return "iOS";
    if (platform === "android") return "Android";
    return "Mobile";
  }

  function mobileDeviceTimeLabel(timestamp: number): string {
    const elapsedSeconds = Math.max(0, Math.floor((mobileNow() - timestamp) / 1_000));
    if (elapsedSeconds < 60) return "Just now";
    const elapsedMinutes = Math.floor(elapsedSeconds / 60);
    if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;
    const elapsedHours = Math.floor(elapsedMinutes / 60);
    if (elapsedHours < 24) return `${elapsedHours}h ago`;
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(timestamp);
  }

  async function updateAvatar(image: AvatarImageInput | null): Promise<void> {
    if (panels.avatar.busy) return;
    setPanels((state) => {
      state.avatar.busy = true;
      state.avatar.error = null;
    });
    try {
      await props.onUpdateAccountAvatar(image);
    } catch (error) {
      setPanels((state) => {
        state.avatar.error = error instanceof Error ? error.message : "Could not update your profile photo.";
      });
    } finally {
      setPanels((state) => {
        state.avatar.busy = false;
      });
    }
  }

  function updateProfileName(value: string): void {
    setPanels((state) => {
      state.profile.name = value;
      state.profile.saveError = null;
      if (!validateProfileName(value).error) state.profile.touched = false;
    });
  }

  function resetProfileName(): void {
    setPanels((state) => {
      state.profile.name = state.profile.savedName;
      state.profile.touched = false;
      state.profile.saveError = null;
    });
  }

  async function saveProfileName(): Promise<void> {
    if (panels.profile.busy) return;
    setPanels((state) => {
      state.profile.touched = true;
      state.profile.saveError = null;
    });
    if (profileNameError()) {
      queueMicrotask(() => profileNameInput?.focus({ preventScroll: true }));
      return;
    }
    if (!profileNameDirty()) return;
    const name = normalizedProfileName();
    setPanels((state) => {
      state.profile.busy = true;
    });
    try {
      await props.onUpdateAccountName(name);
      setPanels((state) => {
        state.profile.savedName = name;
        state.profile.name = name;
        state.profile.touched = false;
      });
    } catch (error) {
      setPanels((state) => {
        state.profile.saveError = error instanceof Error ? error.message : "Could not update your display name.";
      });
      queueMicrotask(() => profileNameInput?.focus({ preventScroll: true }));
    } finally {
      setPanels((state) => {
        state.profile.busy = false;
      });
    }
  }

  async function uploadAvatar(file: File | undefined): Promise<void> {
    if (!file || panels.avatar.busy) return;
    setPanels((state) => {
      state.avatar.busy = true;
      state.avatar.error = null;
    });
    try {
      const image = await (props.processAvatarFile ?? normalizeAvatarFile)(file);
      await props.onUpdateAccountAvatar(image);
    } catch (error) {
      setPanels((state) => {
        state.avatar.error = error instanceof Error ? error.message : "Could not process your profile photo.";
      });
    } finally {
      setPanels((state) => {
        state.avatar.busy = false;
      });
      if (avatarFileInput) avatarFileInput.value = "";
    }
  }

  function loadHostedSites(): Promise<void> {
    if (!props.hostedSitesApi) return Promise.resolve();
    hostedSitesReloadRequested = true;
    if (hostedSitesLoadPromise) return hostedSitesLoadPromise;
    hostedSitesLoadPromise = Promise.resolve().then(async () => {
      try {
        while (hostedSitesReloadRequested) {
          hostedSitesReloadRequested = false;
          setPanels((state) => {
            state.hosting.error = null;
          });
          try {
            const api = props.hostedSitesApi;
            if (api) {
              const sites = await api.list();
              setPanels((state) => {
                state.hosting.sites = sites;
              });
            }
          } catch (error) {
            setPanels((state) => {
              state.hosting.error = error instanceof Error ? error.message : "Could not load hosted sites.";
            });
          }
        }
      } finally {
        hostedSitesLoadPromise = null;
      }
    });
    return hostedSitesLoadPromise;
  }

  createEffect(
    () => props.open && activeTab() === "hosted-sites",
    (shouldLoad) => {
      if (shouldLoad) void loadHostedSites();
    },
  );

  async function deleteSite(site: HostedSiteSummary): Promise<void> {
    if (!props.hostedSitesApi || panels.hosting.busy) return;
    if (!window.confirm(`Delete ${site.hostname}? This address will immediately return 410 Gone.`)) return;
    const analytics = desktopAnalytics.scope();
    setPanels((state) => {
      state.hosting.busy = true;
      state.hosting.error = null;
    });
    try {
      try {
        await props.hostedSitesApi.delete({ siteId: site.id });
      } catch (error) {
        analytics.track("hosted_site_action", {
          action: "delete",
          entry_point: "settings",
          result: "failed",
          failure_code: "delete_failed",
        });
        setPanels((state) => {
          state.hosting.error = error instanceof Error ? error.message : "Could not delete the site.";
        });
        return;
      }
      analytics.track("hosted_site_action", {
        action: "delete",
        entry_point: "settings",
        result: "succeeded",
      });
      await loadHostedSites();
    } catch (error) {
      setPanels((state) => {
        state.hosting.error = error instanceof Error ? error.message : "Could not reload hosted sites.";
      });
    } finally {
      setPanels((state) => {
        state.hosting.busy = false;
      });
    }
  }

  return (
    <Tabs.Root {...tabsProps} class="settings-modal-tabs-root">
      <SettingsDialogShell
        class="app-settings-modal-shell"
        open={props.open}
        onOpenChange={props.onOpenChange}
        title={title()}
        description={description()}
        contentKey={activeTab()}
        restoreFocusTarget={props.restoreFocusTarget}
        onContentElement={(element) => (modalElement = element)}
        footer={
          <Show when={profileNameDirty()}>
            <section class="settings-modal-save-bar" aria-label="Unsaved changes">
              <Text variant="caption" tone="muted">
                Changes not saved
              </Text>
              <div class="settings-modal-save-actions">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={panels.profile.busy}
                  onClick={resetProfileName}
                >
                  Reset
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="default"
                  loading={panels.profile.busy}
                  loadingLabel="Saving…"
                  disabled={panels.profile.busy}
                  onClick={() => void saveProfileName()}
                >
                  Save
                </Button>
              </div>
            </section>
          </Show>
        }
        sidebar={
          <Tabs.List class="settings-modal-nav" aria-label="Settings sections">
            {navItems
              .filter((item) => item.value !== "computer-use" || props.appInfo?.platform === "darwin")
              .map((item) => {
                const NavIcon = item.icon;
                return (
                  <Tabs.Trigger
                    class="settings-modal-nav-item"
                    value={item.value}
                    aria-current={activeTab() === item.value ? "page" : undefined}
                  >
                    <NavIcon aria-hidden="true" />
                    <span>{item.label}</span>
                  </Tabs.Trigger>
                );
              })}
          </Tabs.List>
        }
      >
        <Tabs.Content value="general" class="settings-modal-tab-panel" data-tab="general">
          <SettingsSection title="AI providers">
            <ProviderPicker
              value={selectedProvider()}
              options={providerOptions()}
              ariaLabel="AI providers"
              embedded
              allowUnavailableSelection
              onChange={setSelectedProvider}
              onDownloadProvider={props.onDownloadProvider}
              onCancelProviderDownload={props.onCancelProviderDownload}
              onConnectProvider={props.onConnectProvider}
            />
          </SettingsSection>

          <SettingsSection title="App behavior">
            <ItemGroup class="settings-modal-card">
              <SwitchField
                checked={props.value.launchAtLogin}
                onChange={(checked) => updateSetting("launchAtLogin", checked)}
                label="Launch OpenBot at login"
                description="Open the app when you sign in to this computer."
              />
              <SwitchField
                checked={props.value.keepRunningInBackground}
                onChange={(checked) => updateSetting("keepRunningInBackground", checked)}
                label="Keep OpenBot running in the background"
                description="Keep active tasks running after you close the window."
              />
            </ItemGroup>
          </SettingsSection>

          <SettingsSection title="Workspace">
            <ItemGroup class="settings-modal-card">
              <SwitchField
                checked={props.value.restoreLastWorkspace}
                onChange={(checked) => updateSetting("restoreLastWorkspace", checked)}
                label="Restore the last workspace on launch"
                description="Open the workspace and tasks from your previous session."
              />
              <Item class="settings-modal-row">
                <ItemContent>
                  <ItemTitle>Open external links in</ItemTitle>
                  <ItemDescription>Choose where links from conversations open.</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Select<GeneralSettingsValue["externalLinkTarget"]>
                    class="settings-modal-select"
                    options={linkTargetOptions}
                    value={props.value.externalLinkTarget}
                    onChange={(value) => value && updateSetting("externalLinkTarget", value)}
                    placement="bottom-end"
                    itemComponent={(selectProps) => (
                      <SelectItem item={selectProps.item}>{selectProps.item.rawValue}</SelectItem>
                    )}
                  >
                    <SelectTrigger size="sm" aria-label="Open external links in">
                      <SelectValue<GeneralSettingsValue["externalLinkTarget"]>>
                        {(state) => state.selectedOption()}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent mount={modalElement} />
                  </Select>
                </ItemActions>
              </Item>
            </ItemGroup>
          </SettingsSection>

          <SettingsSection title="Notifications">
            <ItemGroup class="settings-modal-card">
              <SwitchField
                checked={props.value.desktopNotifications}
                onChange={(checked) => updateSetting("desktopNotifications", checked)}
                label="Desktop notifications"
                description="Show a notification when an agent needs attention."
              />
              <SwitchField
                checked={props.value.taskCompletionSound}
                onChange={(checked) => updateSetting("taskCompletionSound", checked)}
                label="Play a sound when a task finishes"
                description="Use a short sound for completed tasks."
              />
            </ItemGroup>
          </SettingsSection>

          <Show when={props.appInfo?.platform === "darwin"}>
            <SettingsSection title="MacBook notch">
              <ItemGroup class="settings-modal-card">
                <SwitchField
                  checked={props.value.macBookNotch}
                  onChange={(checked) => updateSetting("macBookNotch", checked)}
                  label="Show status in the MacBook notch"
                  description="Show agent activity and items that need attention at the top of each display."
                />
                <SwitchField
                  checked={props.value.macBookNotchIdle}
                  disabled={!props.value.macBookNotch}
                  onChange={(checked) => updateSetting("macBookNotchIdle", checked)}
                  label="Show idle island"
                  description="Show the OpenBot logo and greeting when no status is active."
                />
                <SwitchField
                  checked={props.value.macBookNotchAdditionalDisplays}
                  disabled={!props.value.macBookNotch}
                  onChange={(checked) => updateSetting("macBookNotchAdditionalDisplays", checked)}
                  label="Show on additional displays"
                  description="Show Dynamic Island on connected external displays."
                />
                <SwitchField
                  checked={props.value.macBookNotchHaptics}
                  disabled={!props.value.macBookNotch}
                  onChange={(checked) => updateSetting("macBookNotchHaptics", checked)}
                  label="Haptic feedback"
                  description="Use the Force Touch trackpad to confirm Dynamic Island interactions."
                />
              </ItemGroup>
            </SettingsSection>
          </Show>

          <SettingsSection title="Privacy">
            <ItemGroup class="settings-modal-card">
              <SwitchField
                checked={props.value.productAnalytics}
                onChange={(checked) => updateSetting("productAnalytics", checked)}
                label="Share product analytics"
                description="Send usage and reliability metadata with your account ID and email to OpenBot's self-hosted analytics."
              />
            </ItemGroup>
          </SettingsSection>
        </Tabs.Content>

        <Tabs.Content value="computer-use" class="settings-modal-tab-panel" data-tab="computer-use">
          <ComputerUseMacSetup platform={props.appInfo?.platform ?? "darwin"} variant="settings" />
        </Tabs.Content>

        <Tabs.Content value="profile" class="settings-modal-tab-panel" data-tab="profile">
          <SettingsSection title="Identity">
            <Input
              ref={(element) => (avatarFileInput = element)}
              class="sr-only"
              type="file"
              aria-label="Upload profile photo"
              accept="image/png,image/jpeg,image/webp"
              onChange={(event) => void uploadAvatar(event.currentTarget.files?.[0])}
            />
            <ItemGroup class="settings-modal-card">
              <Item class="settings-identity-name-row">
                <ItemContent>
                  <ItemTitle id="settings-profile-name-label">Display name</ItemTitle>
                  <ItemDescription id="settings-profile-name-description">
                    Visible in shared workspaces.
                  </ItemDescription>
                </ItemContent>
                <ItemActions
                  class="settings-identity-name-control"
                  data-invalid={visibleProfileNameError() ? "" : undefined}
                >
                  <Input
                    ref={(element) => (profileNameInput = element)}
                    class="settings-identity-name-input"
                    id="settings-profile-name"
                    size="md"
                    value={panels.profile.name}
                    aria-labelledby="settings-profile-name-label"
                    aria-describedby={
                      visibleProfileNameError() ? "settings-profile-name-error" : "settings-profile-name-description"
                    }
                    aria-invalid={visibleProfileNameError() ? "true" : undefined}
                    onValueChange={updateProfileName}
                    onBlur={() => {
                      if (!profileNameDirty()) return;
                      setPanels((state) => {
                        state.profile.touched = true;
                      });
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" || event.isComposing) return;
                      event.preventDefault();
                      void saveProfileName();
                    }}
                  />
                  <span
                    id="settings-profile-name-error"
                    class="ui-field-error settings-identity-name-error"
                    role="alert"
                    aria-hidden={visibleProfileNameError() ? undefined : "true"}
                  >
                    {visibleProfileNameError() ?? ""}
                  </span>
                </ItemActions>
              </Item>
              <Item class="settings-identity-image-row">
                <ItemContent>
                  <ItemTitle>Profile photo</ItemTitle>
                  <ItemDescription class={panels.avatar.error ? "settings-modal-error" : undefined}>
                    {panels.avatar.error ?? "Shown with your profile in OpenBot."}
                  </ItemDescription>
                </ItemContent>
                <ItemActions class="settings-identity-image-control">
                  <div class="settings-identity-image-picker ui-removable-image">
                    <Button
                      type="button"
                      variant="outline"
                      size="icon-lg"
                      class="settings-identity-image-trigger settings-modal-profile-photo-trigger"
                      aria-label={props.account.avatarUrl ? "Edit profile photo" : "Add profile photo"}
                      disabled={panels.avatar.busy}
                      onClick={() => avatarFileInput?.click()}
                    >
                      <UserAvatar user={props.account} class="settings-modal-avatar" decorative />
                    </Button>
                    <Show when={props.account.avatarUrl && !panels.avatar.busy}>
                      <ImageRemoveButton label="Remove profile photo" onClick={() => void updateAvatar(null)} />
                    </Show>
                  </div>
                </ItemActions>
              </Item>
            </ItemGroup>
          </SettingsSection>

          <SettingsSection title="Account">
            <ItemGroup class="settings-modal-card">
              <Item class="settings-modal-account-email-row">
                <ItemContent>
                  <ItemTitle>Email</ItemTitle>
                  <ItemDescription>Used to sign in to OpenBot.</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Text as="span" class="settings-modal-readonly-value" variant="body">
                    {props.account.email}
                  </Text>
                </ItemActions>
              </Item>
            </ItemGroup>
          </SettingsSection>
          <Show when={props.onListAccountSessions}>
            <SettingsSection
              title="Account sessions"
              description="Sessions stay signed in until you log out or disconnect them. Disconnecting also ends this account's active remote connections."
            >
              <Button
                variant="outline"
                disabled={panels.sessions.loading || Boolean(panels.sessions.revokingId)}
                onClick={() => void refreshAccountSessions()}
              >
                {panels.sessions.loading ? "Loading sessions…" : "Refresh sessions"}
              </Button>
              <Show when={panels.sessions.error}>
                {(error) => (
                  <Text role="alert" class="settings-modal-error">
                    {error()}
                  </Text>
                )}
              </Show>
              <ItemGroup class="settings-modal-card">
                <For each={panels.sessions.items}>
                  {(session) => (
                    <Item>
                      <ItemContent>
                        <ItemTitle>
                          {session.name}
                          {session.current ? " · This device" : ""}
                        </ItemTitle>
                        <ItemDescription>
                          {session.kind === "desktop" ? "Desktop" : "Mobile"} · Signed in{" "}
                          {new Date(session.connectedAt).toLocaleString()} · Last active{" "}
                          {new Date(session.lastActiveAt).toLocaleString()}
                        </ItemDescription>
                      </ItemContent>
                      <ItemActions>
                        <Show when={!session.current} fallback={<Badge>This device</Badge>}>
                          <Button
                            variant="outline"
                            aria-label={`Disconnect ${session.name} session from ${new Date(session.connectedAt).toLocaleString()}`}
                            disabled={Boolean(panels.sessions.revokingId) || !props.onRevokeAccountSession}
                            onClick={() => void revokeAccountSession(session.sessionId)}
                          >
                            {panels.sessions.revokingId === session.sessionId ? "Disconnecting…" : "Disconnect"}
                          </Button>
                        </Show>
                      </ItemActions>
                    </Item>
                  )}
                </For>
              </ItemGroup>
            </SettingsSection>
          </Show>
        </Tabs.Content>

        <Tabs.Content value="mobile-connect" class="settings-modal-tab-panel" data-tab="mobile-connect">
          <SettingsSection
            title="Connect your phone"
            description="Scan a one-time code with the OpenBot mobile app to use this account on your phone."
          >
            <ItemGroup class="settings-modal-card settings-mobile-connect-card">
              <Item class="settings-modal-row settings-mobile-connect-action-row">
                <ItemContent>
                  <ItemTitle>Mobile sign-in</ItemTitle>
                  <ItemDescription>
                    The code expires after two minutes and stops working after the first successful scan.
                  </ItemDescription>
                  <Show when={panels.connect.error}>
                    {(error) => (
                      <ItemDescription class="settings-modal-error" role="alert">
                        {error()}
                      </ItemDescription>
                    )}
                  </Show>
                </ItemContent>
                <ItemActions>
                  <Button
                    type="button"
                    size="sm"
                    loading={panels.connect.busy}
                    loadingLabel="Generating…"
                    disabled={!props.onCreateMobileConnect}
                    onClick={() => void createMobileConnect()}
                  >
                    {panels.connect.session ? "Generate new code" : "Generate QR code"}
                  </Button>
                </ItemActions>
              </Item>

              <Show when={panels.connect.session}>
                {(session) => (
                  <div
                    class="settings-mobile-connect-code-collapse"
                    data-collapsing={session().collapsing ? "" : undefined}
                    aria-hidden={session().collapsing ? "true" : undefined}
                  >
                    <div class="settings-mobile-connect-code-collapse-body">
                      <div class="settings-mobile-connect-code" aria-live="polite">
                        <Show
                          when={!mobileConnectExpired()}
                          fallback={
                            <div class="settings-mobile-connect-expired" role="status">
                              <Smartphone aria-hidden="true" />
                              <Text class="settings-mobile-connect-code-title" variant="body">
                                This code has expired
                              </Text>
                              <Text variant="caption" tone="muted">
                                Generate a new code to connect your phone.
                              </Text>
                            </div>
                          }
                        >
                          <div
                            class="settings-mobile-connect-qr-stage"
                            data-success={session().successDeviceName ? "" : undefined}
                          >
                            <QrCode value={session().ticket.qrData} label="Mobile Connect sign-in QR code" />
                            <Show when={session().successDeviceName}>
                              <div class="settings-mobile-connect-success-mark" aria-hidden="true">
                                <CircleCheck />
                              </div>
                            </Show>
                          </div>
                          <div class="settings-mobile-connect-code-copy">
                            <Show
                              when={session().successDeviceName}
                              fallback={
                                <>
                                  <Text class="settings-mobile-connect-code-title" variant="body">
                                    Open OpenBot on your phone
                                  </Text>
                                  <Text variant="caption" tone="muted">
                                    Choose Scan QR code and point your camera at this code.
                                  </Text>
                                  <Text class="settings-mobile-connect-expiry" variant="caption" aria-atomic="true">
                                    Expires in {mobileConnectExpiryLabel()}
                                  </Text>
                                </>
                              }
                            >
                              {(deviceName) => (
                                <>
                                  <Text
                                    class="settings-mobile-connect-code-title settings-mobile-connect-success-title"
                                    variant="body"
                                  >
                                    Phone connected
                                  </Text>
                                  <Text variant="caption" tone="muted" role="status">
                                    {deviceName()} is ready to use OpenBot.
                                  </Text>
                                </>
                              )}
                            </Show>
                          </div>
                        </Show>
                      </div>
                    </div>
                  </div>
                )}
              </Show>
            </ItemGroup>

            <section class="settings-mobile-devices" aria-labelledby="settings-mobile-devices-title">
              <div class="settings-mobile-devices-heading">
                <h3 id="settings-mobile-devices-title">Connected devices</h3>
                <Show when={panels.devices.loading}>
                  <Text as="span" variant="caption" tone="muted" role="status">
                    Refreshing…
                  </Text>
                </Show>
              </div>
              <Alert tone="neutral">
                <AlertIcon>
                  <Info />
                </AlertIcon>
                <AlertContent>
                  <AlertTitle>Disconnecting a device</AlertTitle>
                  <AlertDescription>
                    Access is revoked immediately. The mobile app may keep showing its current screen until it is
                    reopened or brought back from the background.
                  </AlertDescription>
                </AlertContent>
              </Alert>
              <div class="settings-mobile-devices-states">
                <div
                  class="settings-mobile-devices-state"
                  data-expanded={panels.devices.devices.length === 0 ? "" : undefined}
                  aria-hidden={panels.devices.devices.length > 0 ? "true" : undefined}
                >
                  <div class="settings-mobile-devices-state-body">
                    <div class="settings-mobile-devices-empty" role="status">
                      <Smartphone aria-hidden="true" />
                      <div>
                        <Text class="settings-mobile-devices-empty-title" variant="body">
                          No connected devices
                        </Text>
                        <Text variant="caption" tone="muted">
                          Devices connected with Mobile Connect will appear here.
                        </Text>
                      </div>
                    </div>
                  </div>
                </div>
                <div
                  class="settings-mobile-devices-state"
                  data-expanded={panels.devices.devices.length > 0 ? "" : undefined}
                  aria-hidden={panels.devices.devices.length === 0 ? "true" : undefined}
                >
                  <div class="settings-mobile-devices-state-body">
                    <div class="settings-mobile-devices-table-frame">
                      <table class="settings-mobile-devices-table">
                        <thead>
                          <tr>
                            <th scope="col">Device</th>
                            <th scope="col">Platform</th>
                            <th scope="col">Connected</th>
                            <th scope="col">Last active</th>
                            <th scope="col">
                              <span class="sr-only">Actions</span>
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          <For each={panels.devices.devices}>
                            {(device) => (
                              <tr>
                                <td>
                                  <span class="settings-mobile-device-name">
                                    <Smartphone aria-hidden="true" />
                                    {device.name}
                                  </span>
                                </td>
                                <td>{mobileDevicePlatformLabel(device.platform)}</td>
                                <td>{mobileDeviceTimeLabel(device.connectedAt)}</td>
                                <td>{mobileDeviceTimeLabel(device.lastActiveAt)}</td>
                                <td class="settings-mobile-device-action">
                                  <Button
                                    type="button"
                                    variant="destructive-ghost"
                                    size="xs"
                                    loading={panels.devices.revokingSessionId === device.sessionId}
                                    loadingLabel="Disconnecting…"
                                    disabled={!props.onRevokeMobileConnectedDevice}
                                    aria-label={`Disconnect ${device.name}`}
                                    onClick={() => void revokeMobileDevice(device)}
                                  >
                                    Disconnect
                                  </Button>
                                </td>
                              </tr>
                            )}
                          </For>
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              </div>
              <Show when={panels.devices.error}>
                {(error) => (
                  <Text class="settings-modal-error" variant="caption" role="alert">
                    {error()}
                  </Text>
                )}
              </Show>
            </section>
          </SettingsSection>
        </Tabs.Content>

        <Tabs.Content value="updates" class="settings-modal-tab-panel" data-tab="updates">
          <SettingsSection title="OpenBot updates">
            <ItemGroup class="settings-modal-card">
              <Item class="settings-modal-row settings-modal-update-track-row">
                <ItemContent>
                  <ItemTitle>Update track</ItemTitle>
                  <ItemDescription>Stable receives tested OpenBot releases.</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Select<UpdateTrack>
                    class="settings-modal-update-track-select"
                    options={updateTrackOptions}
                    value="Stable"
                    onChange={() => undefined}
                    placement="bottom-end"
                    itemComponent={(selectProps) => (
                      <SelectItem item={selectProps.item}>{selectProps.item.rawValue}</SelectItem>
                    )}
                  >
                    <SelectTrigger size="sm" aria-label="Update track">
                      <SelectValue<UpdateTrack>>{(state) => state.selectedOption()}</SelectValue>
                    </SelectTrigger>
                    <SelectContent mount={modalElement} />
                  </Select>
                </ItemActions>
              </Item>
              <Item class="settings-modal-row settings-modal-update-row">
                <ItemContent>
                  <ItemTitle>Version {installedVersion()}</ItemTitle>
                  <ItemDescription>Updates follow the Stable track.</ItemDescription>
                  <ItemDescription class={updateMessageClass()}>{updateMessage()}</ItemDescription>
                </ItemContent>
                <ItemActions class="settings-modal-update-actions">
                  <Button
                    variant="outline"
                    type="button"
                    size="sm"
                    loading={updatePresentation().busy}
                    loadingLabel={updatePresentation().actionLabel}
                    disabled={!updatePresentation().supported}
                    onClick={() => void runUpdateAction()}
                  >
                    {updatePresentation().supported ? updatePresentation().actionLabel : "Updates unavailable"}
                  </Button>
                </ItemActions>
              </Item>
              <SwitchField
                checked={props.value.autoDownloadUpdates}
                onChange={(checked) => updateSetting("autoDownloadUpdates", checked)}
                label="Automatically download updates"
                description="Download new versions when they become available."
              />
            </ItemGroup>
          </SettingsSection>
        </Tabs.Content>
        <Tabs.Content value="hosted-sites" class="settings-modal-tab-panel" data-tab="hosted-sites">
          <SettingsSection title="Your sites">
            <Show when={props.hostedSitesApi} fallback={<Text tone="muted">Site hosting is unavailable.</Text>}>
              <div class="hosted-sites-overview">
                <span class="settings-modal-row-title">{panels.hosting.sites.length} of 10 sites</span>
                <Text tone="muted" variant="caption">
                  Sites expire 30 days after publication. Ask an agent to publish or update a site.
                </Text>
              </div>
              <Show when={panels.hosting.error}>{(message) => <p class="settings-modal-error">{message()}</p>}</Show>
              <Show
                when={panels.hosting.sites.length > 0}
                fallback={<Text tone="muted">You do not have a hosted site yet. Ask an agent to publish one.</Text>}
              >
                <ItemGroup class="settings-modal-card hosted-sites-list" surface="subtle">
                  <For each={panels.hosting.sites}>
                    {(site) => (
                      <Item class="hosted-sites-row">
                        <ItemContent>
                          <ItemTitle>{site.title}</ItemTitle>
                          <Button
                            type="button"
                            variant="link"
                            class="hosted-sites-link"
                            title={site.hostname}
                            disabled={site.status !== "active"}
                            onClick={() => void window.openbot.openUrl(site.url)}
                          >
                            <span class="hosted-sites-link-label">{site.hostname}</span>
                          </Button>
                          <Show
                            when={site.status === "blocked"}
                            fallback={
                              <Text tone="muted" variant="caption">
                                {site.expiresAt ? `Expires ${formatDate(site.expiresAt)}` : "Expiry unavailable"}
                              </Text>
                            }
                          >
                            <Badge tone="neutral">Blocked</Badge>
                          </Show>
                        </ItemContent>
                        <ItemActions class="hosted-sites-actions">
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label={`Open ${site.hostname}`}
                            disabled={site.status !== "active"}
                            onClick={() => void window.openbot.openUrl(site.url)}
                          >
                            <ExternalLink size={14} aria-hidden="true" />
                            Open
                          </Button>
                          <Button
                            variant="destructive-ghost"
                            size="sm"
                            aria-label={`Delete ${site.hostname}`}
                            disabled={panels.hosting.busy}
                            onClick={() => void deleteSite(site)}
                          >
                            <Trash2 size={14} aria-hidden="true" />
                            Delete
                          </Button>
                        </ItemActions>
                      </Item>
                    )}
                  </For>
                </ItemGroup>
              </Show>
            </Show>
          </SettingsSection>
        </Tabs.Content>
      </SettingsDialogShell>
    </Tabs.Root>
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}
