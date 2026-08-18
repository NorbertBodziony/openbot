import { cloudflare } from "@cloudflare/vite-plugin";
import solidPlugin from "@solidjs/vite-plugin";
import { tanstackStart } from "@tanstack/solid-start/plugin/vite";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => {
  const localRuntimeVars = command === "serve" ? readLocalRuntimeVars(process.env) : {};
  return {
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
    ],
  };
});

function readLocalRuntimeVars(environment: NodeJS.ProcessEnv): Record<string, string> {
  const allowed = ["AUTH_EXPOSE_DEVELOPMENT_CODE", "EMAIL_SMTP_PASSWORD"] as const;
  return Object.fromEntries(
    allowed.flatMap((key) => {
      const value = environment[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
}
