import type { AgentStatus, ProviderRuntimeSnapshot, UpdateStatus } from "@openbot/contracts/ipc";
import { createSignal } from "solid-js";
import { expect, fn, waitFor, within } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { DEFAULT_GENERAL_SETTINGS } from "../src/app-settings";
import { SettingsModal } from "../src/components/SettingsModal";
import { Button, Heading, Text } from "../src/components/ui";

const storyAppInfo = { name: "OpenBot", version: "0.2.1", platform: "darwin", variant: "dev" } as const;
const storyUpdateStatus: UpdateStatus = {
  phase: "idle",
  currentVersion: "0.2.1",
  availableVersion: null,
  progress: null,
  checkedAt: null,
  message: null,
  errorCode: null,
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

function SettingsModalStory(props: { initialOpen: boolean; providerDownloads?: boolean }) {
  const [open, setOpen] = createSignal(props.initialOpen);
  const [value, setValue] = createSignal({ ...DEFAULT_GENERAL_SETTINGS });
  const [updateStatus, setUpdateStatus] = createSignal<UpdateStatus>(storyUpdateStatus);

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
        onUpdateAction={async () => {
          setUpdateStatus({ ...storyUpdateStatus, phase: "up-to-date", checkedAt: new Date().toISOString() });
        }}
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

export const Interactive: Story = {
  render: () => <SettingsModalStory initialOpen={false} />,
  play: async ({ canvas, userEvent }) => {
    const body = within(document.body);
    const trigger = canvas.getByRole("button", { name: "Open settings" });

    await userEvent.click(trigger);
    let dialog = await body.findByRole("dialog", { name: "General" });
    await waitFor(() => expect(dialog).toBeVisible());
    await expect(body.getByTestId("settings-modal-scroll-frame")).toHaveAttribute("data-scroll-down");
    await expect(body.getByRole("tab", { name: "Appearance" })).toBeDisabled();
    await expect(body.getByRole("tab", { name: "Notifications" })).toBeDisabled();
    await expect(body.getByRole("tab", { name: "Advanced" })).toBeDisabled();

    const generalTab = body.getByRole("tab", { name: "General" });
    generalTab.focus();
    await userEvent.keyboard("{ArrowDown}");
    const profileTab = body.getByRole("tab", { name: "Profile" });
    await expect(profileTab).toHaveAttribute("aria-selected", "true");
    await expect(body.getByRole("heading", { name: "Profile", level: 2 })).toBeVisible();
    await expect(body.getByRole("textbox", { name: "Display name" })).toHaveValue("OpenBot user");

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

    await userEvent.click(body.getByRole("button", { name: "Check for updates" }));
    await expect(body.getByText("OpenBot is up to date.")).toBeVisible();

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
