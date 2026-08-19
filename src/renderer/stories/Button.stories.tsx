import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Button, Heading, IconButton, Search } from "../src/components/ui";

const meta = {
  title: "Foundations/Button",
  component: Button,
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Gallery: Story = {
  render: () => (
    <main class="foundation-story">
      <Heading as="h1" size="lg">
        Buttons
      </Heading>
      <div class="foundation-story-row">
        <Button variant="primary">Primary</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="danger">Danger</Button>
        <Button variant="link">Link action</Button>
      </div>
      <div class="foundation-story-row">
        <Button size="xs">24 px</Button>
        <Button size="sm">28 px</Button>
        <Button size="md">32 px</Button>
        <Button size="lg">36 px</Button>
      </div>
      <div class="foundation-story-row">
        <Button loading loadingLabel="Saving">
          Save
        </Button>
        <Button disabled>Disabled</Button>
        <IconButton label="Search" tooltip="Search">
          <Search />
        </IconButton>
      </div>
    </main>
  ),
};
