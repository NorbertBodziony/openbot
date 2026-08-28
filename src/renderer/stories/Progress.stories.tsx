import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Heading, Progress, RadialProgress, Text } from "../src/components/ui";

const meta = {
  title: "Foundations/Progress",
  component: Progress,
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta<typeof Progress>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Gallery: Story = {
  args: { value: 42, "aria-label": "Download progress" },
  render: (args) => (
    <main class="foundation-story">
      <Heading as="h1" size="lg">
        Progress
      </Heading>
      <div class="foundation-story-stack" style={{ width: "min(100%, 440px)" }}>
        <Text tone="muted">Determinate progress uses the same thin track as provider downloads.</Text>
        <Progress {...args} />
        <Progress value={100} aria-label="Completed download" />
        <div class="foundation-story-row">
          <RadialProgress value={59} aria-label="Normal weekly usage remaining">
            <strong>59%</strong>
          </RadialProgress>
          <RadialProgress value={29} tone="warning" aria-label="Low weekly usage remaining">
            <strong>29%</strong>
          </RadialProgress>
          <RadialProgress value={9} tone="danger" aria-label="Critical weekly usage remaining">
            <strong>9%</strong>
          </RadialProgress>
        </div>
      </div>
    </main>
  ),
};
