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
          // The extension routes the file: renderer logic named `*.test.ts` runs
          // here, without jsdom, and only `*.test.tsx` gets a DOM. Needing jsdom
          // for a logic test means the logic is not separable from the DOM yet.
          include: [
            "src/backend/**/*.test.ts",
            "src/main/**/*.test.ts",
            "src/preload/**/*.test.ts",
            "src/renderer/**/*.test.ts",
            "scripts/**/*.test.ts",
            "packages/contracts/**/*.test.ts",
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "renderer",
          environment: "jsdom",
          // Every spy, global patch and fake timer a test file installs is
          // undone after each test, so nothing depends on file order.
          restoreMocks: true,
          include: ["src/renderer/**/*.test.tsx"],
          setupFiles: ["./src/renderer/src/setupTests.ts"],
        },
      },
    ],
    exclude: [...configDefaults.exclude, "apps/**", "tests/visual/**", ".openbot-build/**", "build/whisper/**"],
  },
});
