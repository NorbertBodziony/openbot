import { EventEmitter, once } from "node:events";
import { isString } from "@openbot/contracts/runtime-values";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  decodeRemoteDesktopSignalBinary,
  decodeRemoteDesktopSignalControl,
  encodeRemoteDesktopSignalBinary,
  encodeRemoteDesktopSignalControl,
} from "./remote-desktop-signal";
import { RemoteViewerProxy } from "./remote-viewer-proxy";

describe("RemoteViewerProxy", () => {
  it("serves viewer resources on loopback and bridges Moonlight signal frames without Base64", async () => {
    const transport = new FakeTransport();
    const proxy = new RemoteViewerProxy({
      transport,
      fetchResource: async () =>
        new Response('<script>fetch("/v1/remote-screen/session")</script>', {
          headers: { "Content-Type": "text/html" },
        }),
    });
    const viewerUrl = await proxy.viewerUrl("host-1", "/v1/remote-screen/sessions/session-1/viewer");
    expect(new URL(viewerUrl).hostname).toBe("127.0.0.1");
    const html = await (await fetch(viewerUrl)).text();
    expect(html).toContain(`${new URL(viewerUrl).pathname.split("/v1/")[0]}/v1/remote-screen/session`);

    const socketUrl = new URL(viewerUrl);
    socketUrl.protocol = "ws:";
    socketUrl.pathname = socketUrl.pathname.replace(/\/viewer$/u, "/stream");
    const socket = new WebSocket(socketUrl);
    await once(socket, "open");
    socket.send("offer-text");
    const [text] = await once(socket, "message");
    expect(text.toString()).toBe("offer-text");
    const binary = new Uint8Array([1, 2, 3, 4]);
    socket.send(binary);
    const [echoed, isBinary] = await once(socket, "message");
    expect(isBinary).toBe(true);
    if (!Buffer.isBuffer(echoed)) throw new Error("The viewer did not return a binary WebSocket frame.");
    expect(new Uint8Array(echoed)).toEqual(binary);
    socket.close();
    await proxy.stop();
  });
});

class FakeTransport extends EventEmitter {
  async sendDesktop(hostId: string, data: string | ArrayBuffer): Promise<void> {
    if (isString(data)) {
      const control = decodeRemoteDesktopSignalControl(data);
      if (control.type === "open") {
        queueMicrotask(() =>
          this.emit(
            "desktopData",
            hostId,
            encodeRemoteDesktopSignalControl({ type: "opened", streamId: control.streamId }),
          ),
        );
      } else if (control.type === "text") {
        queueMicrotask(() => this.emit("desktopData", hostId, data));
      }
      return;
    }
    const frame = decodeRemoteDesktopSignalBinary(data);
    queueMicrotask(() =>
      this.emit("desktopData", hostId, encodeRemoteDesktopSignalBinary(frame.streamId, frame.bytes)),
    );
  }
}
