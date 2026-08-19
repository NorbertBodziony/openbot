import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [solidPlugin(), tailwindcss()],
  test: {
    include: ["tests/visual/**/*.visual.test.tsx"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({}),
      instances: [{ browser: "chromium", viewport: { width: 1280, height: 720 } }],
      expect: {
        toMatchScreenshot: {
          comparatorName: "pixelmatch",
          comparatorOptions: {
            threshold: 0.08,
            allowedMismatchedPixelRatio: 0.002,
          },
        },
      },
    },
  },
});
