import solidPlugin from "@solidjs/vite-plugin";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [solidPlugin()],
  test: {
    execArgv: ["--disable-warning=ExperimentalWarning"],
    globals: true,
    onConsoleLog(log) {
      // Solid 2 RC dependencies still emit this dev-only diagnostic while
      // their components initialize. Keep other console output visible.
      if (log.includes("[STRICT_READ_UNTRACKED]")) return false;
    },
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: [
            "src/backend/**/*.test.ts",
            "src/main/**/*.test.ts",
            "src/preload/**/*.test.ts",
            "scripts/**/*.test.ts",
            "packages/contracts/**/*.test.ts",
            "src/renderer/src/app-message-projection.test.ts",
            "src/renderer/src/dynamic-island-coordinator.test.ts",
            "src/renderer/src/dynamic-island-presentation.test.ts",
            "src/renderer/src/sidebar-people-order.test.ts",
            "src/renderer/src/sidebar-pins.test.ts",
            "src/renderer/src/sidebar-sections.test.ts",
            "src/renderer/src/team-webrtc-framing.test.ts",
            "src/renderer/src/update-status.test.ts",
            "src/renderer/src/voice-recording.test.ts",
            "src/renderer/src/preview/landing-demo.test.ts",
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "renderer",
          environment: "jsdom",
          include: ["src/renderer/**/*.test.{ts,tsx}", "packages/brand/**/*.test.{ts,tsx}"],
          exclude: [
            ...configDefaults.exclude,
            "src/renderer/src/app-message-projection.test.ts",
            "src/renderer/src/dynamic-island-coordinator.test.ts",
            "src/renderer/src/dynamic-island-presentation.test.ts",
            "src/renderer/src/sidebar-people-order.test.ts",
            "src/renderer/src/sidebar-pins.test.ts",
            "src/renderer/src/sidebar-sections.test.ts",
            "src/renderer/src/team-webrtc-framing.test.ts",
            "src/renderer/src/update-status.test.ts",
            "src/renderer/src/voice-recording.test.ts",
            "src/renderer/src/preview/landing-demo.test.ts",
          ],
          setupFiles: ["./src/renderer/src/setupTests.ts"],
        },
      },
    ],
    exclude: [...configDefaults.exclude, "apps/**", "tests/visual/**", ".openbot-build/**", "build/whisper/**"],
  },
});
