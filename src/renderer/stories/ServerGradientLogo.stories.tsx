import { For } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Heading, ServerGradientLogo, serverGradientLogoProfile, Text } from "../src/components/ui";

const GALLERY_SEEDS = [
  "cobalt-labs",
  "lagoon-office",
  "horizon-works",
  "juniper-lab",
  "aurora-research",
  "ocean-labs",
] as const;

const meta = {
  title: "Identity/ServerGradientLogo",
  component: ServerGradientLogo,
  args: { seed: GALLERY_SEEDS[0] },
  parameters: { layout: "centered", a11y: { test: "error" } },
} satisfies Meta<typeof ServerGradientLogo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Single: Story = {};

export const Gallery: Story = {
  parameters: { layout: "fullscreen" },
  render: () => (
    <main
      class="min-h-screen p-8"
      style={{ background: "var(--openbot-bg-canvas)", color: "var(--openbot-text-primary)" }}
    >
      <div class="mx-auto grid max-w-5xl gap-6">
        <header class="grid gap-2">
          <Heading as="h1" size="lg">
            Server gradient logos
          </Heading>
          <Text tone="muted">Six deterministic mesh gradients, shown large and at the 40 px server rail size.</Text>
        </header>

        <div class="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-4">
          <For each={GALLERY_SEEDS}>
            {(seed) => (
              <article
                class="grid justify-items-center gap-4 rounded-2xl p-5"
                style={{
                  background: "var(--openbot-bg-surface)",
                  "box-shadow": "0 0 0 1px var(--openbot-border)",
                }}
              >
                <ServerGradientLogo
                  seed={seed}
                  class="[--server-gradient-logo-radius:20px] [--server-gradient-logo-size:96px]"
                />
                <div class="flex items-center gap-3">
                  <ServerGradientLogo seed={seed} />
                  <div class="grid gap-0.5">
                    <Text variant="label-sm">{seed}</Text>
                    <Text variant="caption" tone="muted">
                      Palette {serverGradientLogoProfile(seed).paletteIndex + 1}
                    </Text>
                  </div>
                </div>
              </article>
            )}
          </For>
        </div>
      </div>
    </main>
  ),
};
