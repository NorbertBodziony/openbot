import solidPlugin from "@solidjs/vite-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [solidPlugin()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/renderer/src/setupTests.ts"],
  },
});
