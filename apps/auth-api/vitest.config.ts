import solidPlugin from "@solidjs/vite-plugin";
import { defineConfig } from "vitest/config";
import { rendererPreviewAlias } from "./renderer-preview-alias";

export default defineConfig({
  plugins: [solidPlugin({ ssr: true })],
  resolve: { alias: { "@openbot/renderer-preview": rendererPreviewAlias } },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    exclude: ["test/hero-download-selector.test.tsx", "test/landing-glow.test.tsx", "test/landing-reveal.test.tsx"],
  },
});
