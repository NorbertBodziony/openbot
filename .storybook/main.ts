import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import type { StorybookConfig } from "storybook-solidjs-vite";
import { mergeConfig, type PluginOption } from "vite";

const config = {
  stories: ["../src/renderer/**/*.stories.@(ts|tsx)"],
  addons: ["@storybook/addon-vitest"],
  framework: {
    name: "storybook-solidjs-vite",
  },
  viteFinal: async (viteConfig) => {
    const mergedConfig = mergeConfig(viteConfig, {
      plugins: [solidPlugin(), tailwindcss()],
      resolve: {
        alias: [{ find: "solid-js/web", replacement: "@solidjs/web" }],
      },
    });
    const plugins = (mergedConfig.plugins ?? []).filter(
      (plugin: PluginOption) => !isLegacySolidPlugin(plugin),
    );
    return {
      ...mergedConfig,
      plugins: [...plugins, solidPlugin()],
    };
  },
} satisfies StorybookConfig;

export default config;

function isLegacySolidPlugin(plugin: PluginOption): boolean {
  if (!plugin || Array.isArray(plugin) || "then" in plugin) return false;
  return "name" in plugin && plugin.name === "solid";
}
