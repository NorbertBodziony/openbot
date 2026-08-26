import solidPlugin from "@solidjs/vite-plugin";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [solidPlugin()],
  test: {
    environment: "jsdom",
    execArgv: ["--disable-warning=ExperimentalWarning"],
    globals: true,
    onConsoleLog(log) {
      // Solid 2 RC dependencies still emit this dev-only diagnostic while
      // their components initialize. Keep other console output visible.
      if (log.includes("[STRICT_READ_UNTRACKED]")) return false;
    },
    setupFiles: ["./src/renderer/src/setupTests.ts"],
    exclude: [...configDefaults.exclude, "apps/**", "tests/visual/**", ".openbot-build/**", "build/whisper/**"],
  },
});
