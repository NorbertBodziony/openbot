import { cloudflare } from "@cloudflare/vite-plugin";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/solid-start/plugin/vite";
import { defineConfig } from "vite";
import { rendererPreviewAlias } from "./renderer-preview-alias";
import { readLocalRuntimeVars } from "./src/server/runtime-env";

export default defineConfig(({ command }) => {
  const localRuntimeVars = command === "serve" ? readLocalRuntimeVars(process.env) : {};
  return {
    resolve: {
      alias: {
        "@openbot/renderer-preview": rendererPreviewAlias,
      },
    },
    server: { host: "127.0.0.1", port: 3100, strictPort: true },
    plugins: [
      cloudflare({
        viteEnvironment: { name: "ssr" },
        config(config) {
          return { vars: { ...config.vars, ...localRuntimeVars } };
        },
      }),
      tanstackStart(),
      solidPlugin({ ssr: true }),
      tailwindcss(),
    ],
  };
});
