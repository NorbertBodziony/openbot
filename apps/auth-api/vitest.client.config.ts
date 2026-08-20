import solidPlugin from "@solidjs/vite-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [solidPlugin()],
  test: {
    environment: "jsdom",
    include: ["test/hero-download-selector.test.tsx", "test/landing-glow.test.tsx", "test/landing-reveal.test.tsx"],
  },
});
