import solidPlugin from "@solidjs/vite-plugin";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [solidPlugin()],
  test: {
    environment: "jsdom",
    globals: true,
    fileParallelism: false,
    setupFiles: ["./src/renderer/src/setupTests.ts"],
    exclude: [...configDefaults.exclude, "apps/**", "tests/visual/**", ".openbot-build/**", "build/whisper/**"],
  },
});
