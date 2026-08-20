import solidPlugin from "@solidjs/vite-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [solidPlugin({ ssr: true })],
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    exclude: [
      "test/hero-download-selector.test.tsx",
      "test/landing-glow.test.tsx",
      "test/landing-reveal.test.tsx",
      "test/product-demo.test.tsx",
    ],
  },
});
