import solidPlugin from "@solidjs/vite-plugin";
import { configDefaults, defineConfig } from "vitest/config";
import { NODE_TEST_TIMEOUT_MS } from "./src/backend/test-deadlines";

export default defineConfig({
  plugins: [solidPlugin()],
  test: {
    execArgv: ["--disable-warning=ExperimentalWarning"],
    globals: true,
    // Every spy, global patch and fake timer a test file installs is undone
    // after each test, in both projects, so nothing depends on file order.
    restoreMocks: true,
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
          // Strictly longer than the harness deadline, so a stalled wait fails
          // with the predicate that never held rather than with vitest's
          // generic "test timed out" - see src/backend/test-deadlines.ts.
          testTimeout: NODE_TEST_TIMEOUT_MS,
          // The file name routes the file, so the project is never a decision:
          // `*.test.ts` runs here without a DOM, `*.test.tsx` needs JSX and
          // gets jsdom, and `*.dom.test.ts` is the narrow case of needing a DOM
          // without rendering a component. Reaching for one of the latter two
          // in a logic test means the logic is not separable from the DOM yet.
          include: [
            "src/backend/**/*.test.ts",
            "src/main/**/*.test.ts",
            "src/preload/**/*.test.ts",
            "src/renderer/**/*.test.ts",
            "scripts/**/*.test.ts",
            "packages/contracts/**/*.test.ts",
            "packages/logging/**/*.test.ts",
            "packages/team-client/**/*.test.ts",
            "apps/mobile/src/features/auth/api/*.test.ts",
          ],
          exclude: [...configDefaults.exclude, "**/*.dom.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "renderer",
          environment: "jsdom",
          include: ["src/renderer/**/*.test.tsx", "src/renderer/**/*.dom.test.ts"],
          setupFiles: ["./src/renderer/src/setupTests.ts"],
        },
      },
    ],
    exclude: [
      ...configDefaults.exclude,
      "apps/auth-api/**",
      "tests/visual/**",
      ".openbot-build/**",
      "build/whisper/**",
    ],
  },
});
