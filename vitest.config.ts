import solidPlugin from "@solidjs/vite-plugin";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [solidPlugin()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/renderer/src/setupTests.ts"],
    exclude: [...configDefaults.exclude, "apps/**"],
  },
});
