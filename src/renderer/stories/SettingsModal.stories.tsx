import type {
  AgentStatus,
  AvatarImageInput,
  CentralAuthUser,
  MobileConnectedDevice,
  ProviderRuntimeSnapshot,
  UpdateStatus,
} from "@openbot/contracts/ipc";
import { createSignal } from "solid-js";
import { expect, fn, waitFor, within } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { DEFAULT_GENERAL_SETTINGS } from "../src/app-settings";
import { SettingsModal } from "../src/components/SettingsModal";
import { Button, Heading, Text } from "../src/components/ui";

const storyAppInfo = { name: "OpenBot", version: "0.2.1", platform: "darwin", variant: "dev" } as const;
const storyAccount: CentralAuthUser = {
  id: "user-1",
  email: "person@example.com",
  name: "Norbert",
  avatarUrl: null,
};
const storyUpdateStatus: UpdateStatus = {
  phase: "idle",
  currentVersion: "0.2.1",
  availableVersion: null,
  progress: null,
  checkedAt: null,
  message: null,
  errorCode: null,
};
const availableUpdateStatus: UpdateStatus = {
  ...storyUpdateStatus,
  phase: "available",
  availableVersion: "0.3.0",
};
const readyUpdateStatus: UpdateStatus = {
  ...availableUpdateStatus,
  phase: "ready",
  progress: 100,
};
const providerAgentStatus: AgentStatus = {
  phase: "blocked",
  cliVersion: null,
  auth: { kind: "unknown" },
  providers: (["codex", "claude", "grok"] as const).map((id) => ({
    id,
    state: "not-installed",
    version: null,
    message: null,
  })),
  capabilities: { chat: "unavailable", browser: "ready", computerUse: "ready" },
  message: null,
  fullAccess: true,
};
const providerRuntimeStatuses: ProviderRuntimeSnapshot["providers"] = {
  codex: { phase: "downloading", progress: 24, message: null, version: null },
  claude: { phase: "downloading", progress: 48, message: null, version: null },
  grok: { phase: "downloading", progress: 72, message: null, version: null },
};

function SettingsModalStory(props: {
  initialOpen: boolean;
  initialUpdateStatus?: UpdateStatus;
  mockDownloadUpdate?: boolean;
  providerDownloads?: boolean;
}) {
  const [open, setOpen] = createSignal(props.initialOpen);
  const [value, setValue] = createSignal({ ...DEFAULT_GENERAL_SETTINGS });
  const [updateStatus, setUpdateStatus] = createSignal<UpdateStatus>(props.initialUpdateStatus ?? storyUpdateStatus);
  const [account, setAccount] = createSignal<CentralAuthUser>({ ...storyAccount });
  const [mobileDevices, setMobileDevices] = createSignal<MobileConnectedDevice[]>([
    {
      sessionId: "11111111-1111-4111-8111-111111111111",
      name: "Norbert’s iPhone",
      platform: "ios",
      connectedAt: Date.now() - 86_400_000,
      lastActiveAt: Date.now() - 45_000,
    },
  ]);

  async function updateAccountAvatar(image: AvatarImageInput | null): Promise<void> {
    const avatarUrl = image
      ? `data:${image.mimeType};base64,${btoa(Array.from(image.bytes, (byte) => String.fromCharCode(byte)).join(""))}`
      : null;
    setAccount((current) => ({ ...current, avatarUrl }));
  }

  async function updateAccountName(name: string): Promise<void> {
    setAccount((current) => ({ ...current, name }));
  }

  async function runUpdateAction(): Promise<void> {
    if (!props.mockDownloadUpdate || updateStatus().phase !== "available") {
      setUpdateStatus({ ...storyUpdateStatus, phase: "up-to-date", checkedAt: new Date().toISOString() });
      return;
    }

    const downloadingStatus = { ...updateStatus(), phase: "downloading", progress: 0 } as const;
    setUpdateStatus(downloadingStatus);
    await new Promise((resolve) => setTimeout(resolve, 400));
    setUpdateStatus({ ...downloadingStatus, progress: 48 });
    await new Promise((resolve) => setTimeout(resolve, 400));
    setUpdateStatus({ ...downloadingStatus, phase: "preparing", progress: 100 });
    await new Promise((resolve) => setTimeout(resolve, 400));
    setUpdateStatus({ ...downloadingStatus, phase: "ready", progress: 100 });
  }

  return (
    <main class="foundation-story foundation-interaction-stage">
      <Heading as="h1" size="lg">
        Workspace settings
      </Heading>
      <Text tone="secondary">Preview the global settings surface with session-scoped preferences.</Text>
      <Button variant="outline" type="button" onClick={() => setOpen(true)}>
        Open settings
      </Button>
      <SettingsModal
        open={open()}
        onOpenChange={setOpen}
        value={value()}
        onValueChange={setValue}
        appInfo={storyAppInfo}
        updateStatus={updateStatus()}
        account={account()}
        onUpdateAccountName={updateAccountName}
        onUpdateAccountAvatar={updateAccountAvatar}
        onCreateMobileConnect={async () => ({
          qrData:
            "openbot://mobile-connect?api=https%3A%2F%2Fapi.openbot.run&ticket=storybook-mobile-ticket_1234567890abcdef",
          expiresAt: Date.now() + 120_000,
        })}
        onListMobileConnectedDevices={async () => mobileDevices()}
        onRevokeMobileConnectedDevice={async (sessionId) => {
          setMobileDevices((current) => current.filter((device) => device.sessionId !== sessionId));
        }}
        onUpdateAction={runUpdateAction}
        agentStatus={props.providerDownloads ? providerAgentStatus : undefined}
        providerRuntimeStatuses={props.providerDownloads ? providerRuntimeStatuses : undefined}
        onDownloadProvider={props.providerDownloads ? fn() : undefined}
        onCancelProviderDownload={props.providerDownloads ? fn() : undefined}
        onConnectProvider={props.providerDownloads ? fn() : undefined}
      />
    </main>
  );
}

const meta = {
  title: "Settings/SettingsModal",
  component: SettingsModal,
  args: {
    open: false,
    onOpenChange: fn(),
    value: DEFAULT_GENERAL_SETTINGS,
    onValueChange: fn(),
    appInfo: storyAppInfo,
    updateStatus: storyUpdateStatus,
    onUpdateAction: fn(async () => undefined),
    account: storyAccount,
    onUpdateAccountName: fn(async () => undefined),
    onUpdateAccountAvatar: fn(async () => undefined),
    onCreateMobileConnect: fn(async () => ({
      qrData:
        "openbot://mobile-connect?api=https%3A%2F%2Fapi.openbot.run&ticket=storybook-mobile-ticket_1234567890abcdef",
      expiresAt: Date.now() + 120_000,
    })),
  },
  parameters: {
    layout: "fullscreen",
    a11y: { test: "error" },
    viewport: {
      options: {
        settingsDesktop: {
          name: "Settings — 1200 × 820",
          styles: { width: "1200px", height: "820px" },
        },
        settingsNarrow: {
          name: "Settings — 640 × 720",
          styles: { width: "640px", height: "720px" },
        },
        settingsPhone: {
          name: "Settings — 420 × 760",
          styles: { width: "420px", height: "760px" },
        },
      },
    },
  },
} satisfies Meta<typeof SettingsModal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {
  render: () => <SettingsModalStory initialOpen />,
};

export const Narrow: Story = {
  render: () => <SettingsModalStory initialOpen />,
  parameters: { viewport: { defaultViewport: "settingsNarrow" } },
};

export const ProviderDownloads: Story = {
  render: () => <SettingsModalStory initialOpen providerDownloads />,
  parameters: { viewport: { defaultViewport: "settingsPhone" } },
};

export const Profile: Story = {
  render: () => <SettingsModalStory initialOpen />,
  play: async ({ userEvent }) => {
    const body = within(document.body);
    await userEvent.click(await body.findByRole("tab", { name: "Profile" }));
  },
};

export const Updates: Story = {
  render: () => <SettingsModalStory initialOpen />,
  play: async ({ userEvent }) => {
    const body = within(document.body);
    await userEvent.click(await body.findByRole("tab", { name: "Updates" }));
  },
};

export const MobileConnect: Story = {
  render: () => <SettingsModalStory initialOpen />,
  play: async ({ userEvent }) => {
    const body = within(document.body);
    await userEvent.click(await body.findByRole("tab", { name: "Mobile Connect" }));
    await userEvent.click(await body.findByRole("button", { name: "Generate QR code" }));
    await expect(await body.findByRole("img", { name: "Mobile Connect sign-in QR code" })).toBeVisible();
  },
};

export const UpdateAvailable: Story = {
  render: () => <SettingsModalStory initialOpen initialUpdateStatus={availableUpdateStatus} />,
  play: async ({ userEvent }) => {
    const body = within(document.body);
    await userEvent.click(await body.findByRole("tab", { name: "Updates" }));
  },
};

export const DownloadUpdateFlow: Story = {
  render: () => <SettingsModalStory initialOpen initialUpdateStatus={availableUpdateStatus} mockDownloadUpdate />,
  play: async ({ step, userEvent }) => {
    const body = within(document.body);

    await step("Open the available OpenBot update", async () => {
      await userEvent.click(await body.findByRole("tab", { name: "Updates" }));
      await expect(body.getByText("OpenBot v0.3.0 is available to download.")).toBeVisible();
    });

    await step("Start the mocked download", async () => {
      const downloadButton = body.getByRole("button", { name: "Download update" });
      await expect(downloadButton).toBeEnabled();
      await userEvent.click(downloadButton);
      await expect(await body.findByText("Downloading OpenBot v0.3.0 · 0%")).toBeVisible();
      await expect(body.getByRole("button", { name: "Downloading update…" })).toBeDisabled();
    });

    await step("Finish the mocked download", async () => {
      await waitFor(() => expect(body.getByText("Downloading OpenBot v0.3.0 · 48%")).toBeVisible());
      await waitFor(() => expect(body.getByText("Preparing OpenBot v0.3.0…")).toBeVisible());
      await waitFor(() => expect(body.getByText("OpenBot v0.3.0 is ready. Restart to apply.")).toBeVisible());
      await expect(body.getByRole("button", { name: "Restart to update" })).toBeEnabled();
    });
  },
};

export const ReadyToInstall: Story = {
  render: () => <SettingsModalStory initialOpen initialUpdateStatus={readyUpdateStatus} />,
  play: async ({ userEvent }) => {
    const body = within(document.body);
    await userEvent.click(await body.findByRole("tab", { name: "Updates" }));
  },
};

export const Interactive: Story = {
  render: () => <SettingsModalStory initialOpen={false} />,
  play: async ({ canvas, userEvent }) => {
    const body = within(document.body);
    const trigger = canvas.getByRole("button", { name: "Open settings" });

    await userEvent.click(trigger);
    let dialog = await body.findByRole("dialog", { name: "General" });
    await waitFor(() => expect(dialog).toBeVisible());
    await expect(body.getByTestId("settings-modal-scroll-frame")).toHaveAttribute("data-scroll-down");

    const generalTab = body.getByRole("tab", { name: "General" });
    generalTab.focus();
    await userEvent.keyboard("{ArrowDown}");
    const profileTab = body.getByRole("tab", { name: "Profile" });
    await expect(profileTab).toHaveAttribute("aria-selected", "true");
    await expect(body.getByRole("heading", { name: "Profile", level: 2 })).toBeVisible();
    await expect(body.getByRole("textbox", { name: "Display name" })).toHaveValue("Norbert");

    await userEvent.keyboard("{ArrowDown}");
    const updatesTab = body.getByRole("tab", { name: "Updates" });
    await expect(updatesTab).toHaveAttribute("aria-selected", "true");
    await expect(body.getByRole("heading", { name: "Updates", level: 2 })).toBeVisible();

    await userEvent.click(generalTab);
    await expect(generalTab).toHaveAttribute("aria-selected", "true");

    const linkTarget = body.getByRole("button", { name: /^Open external links in/ });
    await userEvent.click(linkTarget);
    await waitFor(() => expect(body.getByRole("listbox")).toBeVisible());
    await userEvent.click(body.getByRole("option", { name: "OpenBot" }));
    await expect(linkTarget).toHaveTextContent("OpenBot");

    const launchSwitch = body.getByRole("switch", { name: "Launch OpenBot at login" });
    await expect(launchSwitch).toBeChecked();
    await userEvent.click(launchSwitch);
    await expect(launchSwitch).not.toBeChecked();

    await userEvent.click(updatesTab);
    await userEvent.click(body.getByRole("button", { name: "Check for updates" }));
    await expect(body.getByText("OpenBot is up to date on the Stable track.")).toBeVisible();

    await userEvent.click(generalTab);

    await userEvent.click(body.getByRole("button", { name: "Close settings" }));
    await expect(dialog).toHaveAttribute("data-motion", "closing");
    await waitFor(() => expect(body.queryByRole("dialog", { name: "General" })).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());

    await userEvent.click(trigger);
    dialog = await body.findByRole("dialog", { name: "General" });
    await expect(body.getByRole("switch", { name: "Launch OpenBot at login" })).not.toBeChecked();
    await userEvent.keyboard("{Escape}");
    await expect(dialog).toHaveAttribute("data-motion", "closing");
    await waitFor(() => expect(body.queryByRole("dialog", { name: "General" })).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());

    await userEvent.click(trigger);
    await body.findByRole("dialog", { name: "General" });
    await userEvent.click(body.getByTestId("settings-modal-backdrop"));
    await waitFor(() => expect(body.queryByRole("dialog", { name: "General" })).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  },
};
