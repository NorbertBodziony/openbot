import { resolve } from "node:path";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

const rendererPort = readRendererPort(process.env.OPENBOT_DEV_RENDERER_PORT);

export default defineConfig({
  main: {
    // Workspace sources ship as TypeScript; like contracts, logging must be
    // bundled, otherwise the packaged app would require .ts at runtime.
    plugins: [externalizeDepsPlugin({ exclude: ["@openbot/contracts", "@openbot/logging"] })],
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ["@openbot/contracts"] })],
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/preload/index.ts"),
          teamWebrtc: resolve("src/preload/team-webrtc.ts"),
        },
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
        },
      },
    },
  },
  renderer: {
    plugins: [solidPlugin(), tailwindcss({ optimize: false })],
    optimizeDeps: {
      include: ["@norbert_bodziony/bloub"],
    },
    resolve: {
      dedupe: ["solid-js", "@solidjs/web"],
    },
    server: rendererPort ? { port: rendererPort, strictPort: true } : undefined,
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/renderer/index.html"),
          browserPip: resolve("src/renderer/browser-pip.html"),
          browserPipControls: resolve("src/renderer/browser-pip-controls.html"),
          teamWebrtc: resolve("src/renderer/team-webrtc.html"),
        },
      },
    },
  },
});

function readRendererPort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1_024 || port > 65_535) {
    throw new Error("OPENBOT_DEV_RENDERER_PORT must be an integer from 1024 to 65535.");
  }
  return port;
}
