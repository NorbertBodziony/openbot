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
    const viewer = new URL(viewerUrl);
    const tokenPath = viewer.pathname.split("/host-1/")[0];
    expect((await fetch(`${viewer.origin}${tokenPath}/%/x`)).status).toBe(404);
    socket.close();
    await proxy.stop();
  });

  it("closes only the affected viewer when desktop forwarding fails", async () => {
    const transport = new FailingFrameTransport();
    const proxy = new RemoteViewerProxy({ transport, fetchResource: async () => new Response() });
    const viewerUrl = await proxy.viewerUrl("host-1", "/v1/remote-screen/sessions/session-1/viewer");
    const socketUrl = new URL(viewerUrl);
    socketUrl.protocol = "ws:";
    socketUrl.pathname = socketUrl.pathname.replace(/\/viewer$/u, "/stream");
    const socket = new WebSocket(socketUrl);
    await once(socket, "open");
    await transport.opened;
    socket.send("offer-text");
    const [code] = await once(socket, "close");
    expect(code).toBe(1011);
    await proxy.stop();
  });

  it("closes a viewer when its open desktop forwarding queue exceeds the limit", async () => {
    const transport = new SlowFrameTransport();
    const proxy = new RemoteViewerProxy({ transport, fetchResource: async () => new Response() });
    const viewerUrl = await proxy.viewerUrl("host-1", "/v1/remote-screen/sessions/session-1/viewer");
    const socketUrl = new URL(viewerUrl);
    socketUrl.protocol = "ws:";
    socketUrl.pathname = socketUrl.pathname.replace(/\/viewer$/u, "/stream");
    const socket = new WebSocket(socketUrl);
    await once(socket, "open");
    await transport.opened;
    const closed = once(socket, "close");
    for (let index = 0; index < 17; index += 1) socket.send(Buffer.alloc(64 * 1024));

    const [code] = await closed;
    expect(code).toBe(1009);
    transport.release();
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

class FailingFrameTransport extends FakeTransport {
  readonly opened = new Promise<void>((resolve) => {
    this.once("opened", resolve);
  });

  override async sendDesktop(hostId: string, data: string | ArrayBuffer): Promise<void> {
    if (isString(data) && decodeRemoteDesktopSignalControl(data).type === "text") {
      throw new Error("The desktop channel closed.");
    }
    await super.sendDesktop(hostId, data);
    if (isString(data) && decodeRemoteDesktopSignalControl(data).type === "open") this.emit("opened");
  }
}

class SlowFrameTransport extends FakeTransport {
  readonly opened = new Promise<void>((resolve) => {
    this.once("opened", resolve);
  });
  readonly #blocked: Promise<void>;
  readonly release: () => void;

  constructor() {
    super();
    let release!: () => void;
    this.#blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.release = release;
  }

  override async sendDesktop(hostId: string, data: string | ArrayBuffer): Promise<void> {
    if (!isString(data)) await this.#blocked;
    await super.sendDesktop(hostId, data);
    if (isString(data) && decodeRemoteDesktopSignalControl(data).type === "open") this.emit("opened");
  }
}
