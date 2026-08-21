import type { RemoteDesktopSession } from "@openbot/contracts/ipc";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { RemoteDesktopWorkspace } from "../src/components/RemoteDesktopWorkspace";
import { STORY_SERVERS } from "./fixtures";

const remoteServer = STORY_SERVERS.find((server) => server.kind === "remote");
if (!remoteServer) throw new Error("The remote desktop story requires a remote server fixture.");

const server = { ...remoteServer, state: "online" as const, remoteDesktopAvailable: true };
const session: RemoteDesktopSession = {
  id: "storybook-remote-desktop",
  serverId: server.id,
  viewerUrl: "about:blank",
  viewerGrant: "storybook-grant",
  displays: [
    { id: "1", label: "Built-in Retina Display", width: 3024, height: 1964, primary: true },
    { id: "2", label: "LG HDR WFHD", width: 2560, height: 1080, primary: false },
  ],
  selectedDisplayId: "1",
  phase: "connected",
  transport: "p2p",
  errorCode: null,
  message: "Remote control connected.",
  createdAt: "2026-08-21T12:00:00.000Z",
  grantExpiresAt: "2026-08-21T12:01:00.000Z",
};

const args: Parameters<typeof RemoteDesktopWorkspace>[0] = {
  visible: true,
  platform: "darwin",
  server,
  session,
  connecting: false,
  connectionError: null,
  onHide: fn(),
  onRetry: fn(async () => undefined),
  onSelectDisplay: fn(async () => undefined),
  onDisconnect: fn(async () => undefined),
};

const meta = {
  title: "Team/RemoteDesktopWorkspace",
  component: RemoteDesktopWorkspace,
  args,
  decorators: [(Story) => <div style="height: 720px; background: var(--openbot-bg);">{Story()}</div>],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof RemoteDesktopWorkspace>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ConnectedP2P: Story = {};

export const Connecting: Story = {
  args: {
    session: { ...session, phase: "connecting", transport: "unknown", message: "Connecting through Sunshine…" },
    connecting: true,
  },
};

export const ConnectionError: Story = {
  args: {
    session: undefined,
    connectionError: "The direct P2P connection could not start.",
  },
};

export const UpdateRequired: Story = {
  args: { server: { ...server, remoteDesktopAvailable: false }, session: undefined },
};
