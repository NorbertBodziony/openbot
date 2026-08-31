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
        <Badge variant="secondary">Secondary</Badge>
        <Badge variant="primary-light">Primary</Badge>
        <Badge variant="success-light">Success</Badge>
        <Badge variant="warning-light">Warning</Badge>
        <Badge variant="destructive-light">Destructive</Badge>
      </div>
      <div class="foundation-story-row">
        <Badge variant="outline">Outline</Badge>
        <Badge variant="success-outline">Success outline</Badge>
        <Badge variant="warning-outline">Warning outline</Badge>
      </div>
    </main>
  ),
};
