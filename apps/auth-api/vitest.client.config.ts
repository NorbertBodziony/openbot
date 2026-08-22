import solidPlugin from "@solidjs/vite-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [solidPlugin()],
  test: {
    environment: "jsdom",
    environmentOptions: { jsdom: { url: "https://openbot.run/" } },
    setupFiles: ["@testing-library/jest-dom/vitest"],
    include: [
      "test/analytics.test.ts",
      "test/hero-download-selector.test.tsx",
      "test/join-page.test.tsx",
      "test/landing-app-preview.test.tsx",
      "test/landing-glow.test.tsx",
      "test/landing-reveal.test.tsx",
    ],
  },
});
