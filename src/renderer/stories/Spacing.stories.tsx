import { For } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Heading, Text } from "../src/components/ui";

const spaces = [2, 4, 6, 8, 12, 16, 20, 24, 32] as const;

const meta = {
  title: "Foundations/Spacing",
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Scale: Story = {
  render: () => (
    <main class="foundation-story">
      <Heading as="h1" size="lg">
        Spacing scale
      </Heading>
      <div class="foundation-story-stack">
        <For each={spaces}>
          {(space) => (
            <div class="foundation-story-row">
              <Text variant="label-sm" tone="secondary">
                {space}px
              </Text>
              <div class="foundation-spacing-sample" style={{ "--foundation-space": `${space}px` }} />
            </div>
          )}
        </For>
      </div>
    </main>
  ),
};
