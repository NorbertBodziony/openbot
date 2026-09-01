import { type IpcRendererEvent, ipcRenderer } from "electron";

ipcRenderer.once("openbot-team-webrtc-port", (event: IpcRendererEvent) => {
  const port = event.ports[0];
  if (!port) throw new Error("The Team WebRTC message port is missing.");
  window.postMessage("openbot-team-webrtc-port", "*", [port]);
});
