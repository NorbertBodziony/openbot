import solidPlugin from "@solidjs/vite-plugin";
import { defineConfig } from "vitest/config";
import { rendererPreviewAlias } from "./renderer-preview-alias";

export default defineConfig({
  plugins: [solidPlugin({ ssr: true })],
  resolve: {
    alias: {
      "@openbot/renderer-preview": rendererPreviewAlias,
    },
  },
  test: {
    environment: "node",
    execArgv: ["--disable-warning=ExperimentalWarning"],
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    exclude: [
      "test/analytics.test.ts",
      "test/hero-download-selector.test.tsx",
      "test/join-page.test.tsx",
      "test/landing-app-preview.test.tsx",
      "test/landing-glow.test.tsx",
      "test/landing-reveal.test.tsx",
    ],
  },
});
