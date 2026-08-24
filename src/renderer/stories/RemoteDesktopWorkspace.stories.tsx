import type { RemoteDesktopSession } from "@openbot/contracts/ipc";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { RemoteDesktopWorkspace } from "../src/components/RemoteDesktopWorkspace";
import macDesktopMock from "./assets/remote-desktop-mac-mock.png";
import { STORY_SERVERS } from "./fixtures";

const remoteServer = STORY_SERVERS.find((server) => server.kind === "remote");
if (!remoteServer) throw new Error("The remote desktop story requires a remote server fixture.");

const server = { ...remoteServer, state: "online" as const, remoteDesktopAvailable: true };
const sessionId = "storybook-remote-desktop";
const session: RemoteDesktopSession = {
  id: sessionId,
  serverId: server.id,
  viewerUrl: createMockViewerUrl(macDesktopMock, sessionId),
  viewerGrant: "storybook-grant",
  displays: [
    { id: "1", label: "Built-in Retina Display", width: 3024, height: 1964, primary: true },
    { id: "2", label: "LG HDR WFHD", width: 2560, height: 1080, primary: false },
    { id: "3", label: "Studio Display", width: 5120, height: 2880, primary: false },
    { id: "4", label: "iPad Pro — Sidecar", width: 2732, height: 2048, primary: false },
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

export const ConnectedSingleDisplay: Story = {
  args: {
    session: { ...session, displays: session.displays.slice(0, 1) },
  },
};

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

function createMockViewerUrl(imageUrl: string, id: string) {
  const absoluteImageUrl = new URL(imageUrl, window.location.origin).href;
  const viewerState = JSON.stringify({
    source: "openbot-moonlight",
    type: "viewer-state",
    sessionId: id,
    state: "connected",
    transport: "p2p",
    message: "Remote control connected.",
  });
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      * { box-sizing: border-box; }
      html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #050507; }
      img { display: block; width: 100%; height: 100%; object-fit: contain; }
    </style>
  </head>
  <body>
    <img src="${absoluteImageUrl}" alt="Mock Mac desktop" />
    <script>
      window.addEventListener("load", () => {
        setTimeout(() => parent.postMessage(${viewerState}, "*"), 0);
      });
    </script>
  </body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
