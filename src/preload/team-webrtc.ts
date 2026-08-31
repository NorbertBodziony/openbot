import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("openbotTeamWebRtc", {
  receivePort(callback: (port: MessagePort) => void): void {
    ipcRenderer.once("openbot-team-webrtc-port", (event: IpcRendererEvent) => {
      const port = event.ports[0];
      if (!port) throw new Error("The Team WebRTC message port is missing.");
      callback(port);
    });
  },
});
