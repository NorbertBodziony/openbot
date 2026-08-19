import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Heading, Text } from "../src/components/ui";

const meta = {
  title: "Foundations/Typography",
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Scale: Story = {
  render: () => (
    <main class="foundation-story">
      <section class="foundation-story-stack">
        <Heading as="h1" size="display">
          OpenBot UI foundation
        </Heading>
        <Heading as="h2" size="lg">
          Large section heading
        </Heading>
        <Heading as="h3" size="md">
          Standard section heading
        </Heading>
        <Heading as="h4" size="sm">
          Compact section heading
        </Heading>
      </section>
      <section class="foundation-story-stack">
        <Text variant="body">Body — readable copy for primary content and longer explanations.</Text>
        <Text variant="body-sm">Body small — the default density for desktop application UI.</Text>
        <Text variant="label">Label — controls and high-value metadata.</Text>
        <Text variant="label-sm" tone="secondary">
          Small label — supporting control text.
        </Text>
        <Text variant="caption" tone="muted">
          Caption — timestamps, hints, and tertiary metadata.
        </Text>
      </section>
      <section class="foundation-story-row">
        <Text tone="primary">Primary</Text>
        <Text tone="secondary">Secondary</Text>
        <Text tone="muted">Muted</Text>
        <Text tone="success">Success</Text>
        <Text tone="warning">Warning</Text>
        <Text tone="danger">Danger</Text>
      </section>
    </main>
  ),
};
