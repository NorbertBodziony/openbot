import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";

let receivedPort: MessagePort | null = null;
let rendererReady = false;

function deliverPort(): void {
  if (!receivedPort || !rendererReady) return;
  const port = receivedPort;
  receivedPort = null;
  rendererReady = false;
  window.postMessage("openbot-team-webrtc-port", "*", [port]);
}

ipcRenderer.once("openbot-team-webrtc-port", (event: IpcRendererEvent) => {
  const port = event.ports[0];
  if (!port) throw new Error("The Team WebRTC message port is missing.");
  receivedPort = port;
  deliverPort();
});

contextBridge.exposeInMainWorld("openbotTeamWebRtc", {
  readyForPort(): void {
    rendererReady = true;
    deliverPort();
  },
});
