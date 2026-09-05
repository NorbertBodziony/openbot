import type { RemoteDesktopSession, ServerSummary } from "@openbot/contracts/ipc";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { RemoteDesktopWorkspace } from "./RemoteDesktopWorkspace";

const server: ServerSummary = {
  id: "remote-1",
  name: "Studio Mac",
  logoUrl: null,
  kind: "remote",
  state: "online",
  apiUrl: "https://studio.example.com",
  remoteDesktopAvailable: true,
  role: "member",
  active: true,
};

const session: RemoteDesktopSession = {
  id: "desktop-1",
  serverId: server.id,
  viewerUrl: "https://studio.example.com/v1/remote-screen/sessions/desktop-1/viewer",
  viewerGrant: "one-time-viewer-grant",
  displays: [
    { id: "display-1", label: "Main display", width: 3024, height: 1964, primary: true },
    { id: "display-2", label: "Second display", width: 1920, height: 1080, primary: false },
  ],
  selectedDisplayId: "display-1",
  phase: "connecting",
  transport: "unknown",
  errorCode: null,
  message: "Connecting…",
  createdAt: "2026-08-20T12:00:00.000Z",
  grantExpiresAt: "2026-08-20T12:01:00.000Z",
};

function renderWorkspace(overrides: { session?: RemoteDesktopSession; visible?: boolean } = {}) {
  const [visible, setVisible] = createSignal(overrides.visible ?? true);
  const onHide = vi.fn(() => setVisible(false));
  const onRetry = vi.fn(async () => undefined);
  const onSelectDisplay = vi.fn(async () => undefined);
  const onDisconnect = vi.fn(async () => undefined);
  render(() => (
    <RemoteDesktopWorkspace
      visible={visible()}
      platform="darwin"
      server={server}
      session={overrides.session}
      connecting={!overrides.session}
      connectionError={null}
      onHide={onHide}
      onRetry={onRetry}
      onSelectDisplay={onSelectDisplay}
      onDisconnect={onDisconnect}
    />
  ));
  return { onHide, onRetry, onSelectDisplay, onDisconnect, setVisible };
}

describe("RemoteDesktopWorkspace", () => {
  it("keeps the Moonlight iframe mounted when the workspace is hidden", async () => {
    const { onHide, onDisconnect, setVisible } = renderWorkspace({ session });
    const frame = screen.getByTitle("Sunshine remote desktop");
    const workspace = screen.getByRole("main", { name: "Remote control" });
    expect(frame).toHaveAttribute("src", `${session.viewerUrl}#${session.viewerGrant}`);
    expect(frame).toHaveAttribute("sandbox", expect.stringContaining("allow-pointer-lock"));

    await fireEvent.click(screen.getByRole("button", { name: "Back to OpenBot" }));
    expect(onHide).toHaveBeenCalledOnce();
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(workspace).toHaveAttribute("aria-hidden", "true");
    expect(workspace.inert).toBe(true);
    expect(screen.getByTitle("Sunshine remote desktop")).toBe(frame);

    setVisible(true);
    await waitFor(() => expect(workspace).not.toHaveAttribute("aria-hidden"));
    expect(screen.getByTitle("Sunshine remote desktop")).toBe(frame);
  });

  it("keeps the header minimal and supports selecting a shared monitor", async () => {
    const { onSelectDisplay, onDisconnect } = renderWorkspace({ session });
    const frame = screen.getByTitle("Sunshine remote desktop");
    if (!(frame instanceof HTMLIFrameElement)) throw new Error("Remote viewer is not an iframe.");

    window.dispatchEvent(
      new MessageEvent("message", {
        origin: new URL(session.viewerUrl).origin,
        source: frame.contentWindow,
        data: {
          source: "openbot-moonlight",
          type: "viewer-state",
          sessionId: session.id,
          state: "connected",
          transport: "p2p",
        },
      }),
    );
    await fireEvent.pointerDown(screen.getByRole("button", { name: /Remote display/ }), {
      pointerType: "mouse",
      button: 0,
    });
    await fireEvent.click(screen.getByRole("option", { name: "Second display" }));
    expect(onSelectDisplay).toHaveBeenCalledWith(server.id, "display-2");
    const disconnectButton = screen.getByRole("button", { name: "Disconnect" });
    await waitFor(() => expect(disconnectButton).toBeEnabled());
    await fireEvent.click(disconnectButton);
    await waitFor(() => expect(onDisconnect).toHaveBeenCalledOnce());
    expect(screen.queryByLabelText(/password/iu)).not.toBeInTheDocument();
    expect(screen.queryByText(/view.only/iu)).not.toBeInTheDocument();
  });

  it("retries a failed connection without using Escape as a close action", async () => {
    const failed = {
      ...session,
      phase: "error" as const,
      errorCode: "connection_failed" as const,
      message: "The WebRTC connection failed.",
    };
    const { onHide, onRetry } = renderWorkspace({ session: failed });

    await fireEvent.keyDown(screen.getByRole("main", { name: "Remote control" }), { key: "Escape" });
    expect(onHide).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(onRetry).toHaveBeenCalledOnce());
  });
});
