import { cloudflare } from "@cloudflare/vite-plugin";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/solid-start/plugin/vite";
import { defineConfig } from "vite";
import { landingPreviewAlias, rendererPreviewAlias } from "./renderer-preview-alias";
import { readLocalRuntimeVars } from "./src/server/runtime-env";

export default defineConfig(({ command }) => {
  const localRuntimeVars = command === "serve" ? readLocalRuntimeVars(process.env) : {};
  return {
    resolve: {
      alias: {
        "@openbot/landing-preview": landingPreviewAlias,
        "@openbot/renderer-preview": rendererPreviewAlias,
      },
    },
    server: { host: "127.0.0.1", port: readApiPort(process.env.OPENBOT_API_PORT), strictPort: true },
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

function readApiPort(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 3_100;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1_024 || port > 65_535) {
    throw new Error("OPENBOT_API_PORT must be an integer from 1024 to 65535.");
  }
  return port;
}
