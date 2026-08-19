import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Badge, Heading } from "../src/components/ui";

const meta = {
  title: "Foundations/Badge",
  component: Badge,
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta<typeof Badge>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Gallery: Story = {
  render: () => (
    <main class="foundation-story">
      <Heading as="h1" size="lg">
        Badges
      </Heading>
      <div class="foundation-story-row">
        <Badge tone="neutral">Neutral</Badge>
        <Badge tone="accent">Accent</Badge>
        <Badge tone="success" dot>
          Connected
        </Badge>
        <Badge tone="warning" dot>
          Waiting
        </Badge>
        <Badge tone="danger" dot>
          Failed
        </Badge>
      </div>
      <div class="foundation-story-row">
        <Badge size="sm" shape="rounded">
          Small
        </Badge>
        <Badge shape="pill">Status pill</Badge>
      </div>
    </main>
  ),
};
