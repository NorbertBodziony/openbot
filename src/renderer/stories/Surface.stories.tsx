import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Card, Heading, Kbd, Separator, Skeleton, Spinner, Text } from "../src/components/ui";

const meta = {
  title: "Foundations/Surface",
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Gallery: Story = {
  render: () => (
    <main class="foundation-story">
      <Heading as="h1" size="lg">
        Surfaces and feedback
      </Heading>
      <div class="foundation-surface-grid">
        <Card class="foundation-surface-card">
          <Heading as="h2" size="sm">
            Card
          </Heading>
          <Text tone="secondary">A neutral container for related information and actions.</Text>
          <Separator />
          <Text variant="caption" tone="muted">
            Press <Kbd>⌘K</Kbd> to search
          </Text>
        </Card>
        <Card class="foundation-surface-card">
          <Heading as="h2" size="sm">
            Loading
          </Heading>
          <div class="foundation-story-row">
            <Spinner label="Loading content" />
            <Text tone="secondary">Loading content…</Text>
          </div>
          <div class="foundation-skeleton-stack">
            <Skeleton class="foundation-skeleton-line" />
            <Skeleton class="foundation-skeleton-line foundation-skeleton-line-short" />
          </div>
        </Card>
      </div>
    </main>
  ),
};
