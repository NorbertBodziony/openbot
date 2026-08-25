import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Button, Heading, IconButton, Plus, Search, Text, Trash2 } from "../src/components/ui";

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

      <section class="foundation-story-section" aria-labelledby="button-variants">
        <Heading id="button-variants" as="h2" size="sm">
          Variants
        </Heading>
        <div class="foundation-story-row">
          <Button variant="default">Default</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Destructive</Button>
          <Button variant="destructive-ghost">Destructive ghost</Button>
          <Button variant="link">Link action</Button>
        </div>
      </section>

      <section class="foundation-story-section" aria-labelledby="button-sizes">
        <Heading id="button-sizes" as="h2" size="sm">
          Sizes
        </Heading>
        <div class="foundation-story-row">
          <Button variant="default" size="xs">
            XS · 24 px
          </Button>
          <Button variant="default" size="sm">
            Small · 32 px
          </Button>
          <Button variant="default" size="default">
            Default · 36 px
          </Button>
          <Button variant="default" size="lg">
            Large · 40 px
          </Button>
        </div>
      </section>

      <section class="foundation-story-section" aria-labelledby="icon-button-sizes">
        <Heading id="icon-button-sizes" as="h2" size="sm">
          Icon buttons
        </Heading>
        <div class="foundation-story-row">
          <IconButton label="Add, extra small" size="icon-xs" variant="outline">
            <Plus />
          </IconButton>
          <IconButton label="Search, small" size="icon-sm" variant="outline">
            <Search />
          </IconButton>
          <IconButton label="Search, default" size="icon" variant="outline">
            <Search />
          </IconButton>
          <IconButton label="Search, large" size="icon-lg" variant="outline">
            <Search />
          </IconButton>
          <IconButton label="Delete" size="icon-sm" variant="destructive-ghost">
            <Trash2 />
          </IconButton>
        </div>
      </section>

      <section class="foundation-story-section" aria-labelledby="button-states">
        <Heading id="button-states" as="h2" size="sm">
          States
        </Heading>
        <Text tone="secondary">Use Tab to check focus. Hover destructive controls directly.</Text>
        <div class="foundation-story-row">
          <Button variant="default" loading loadingLabel="Saving">
            Save
          </Button>
          <Button variant="default" disabled>
            Disabled
          </Button>
          <Button variant="outline" aria-expanded="true">
            Expanded
          </Button>
          <Button variant="outline" aria-invalid="true">
            Invalid
          </Button>
        </div>
      </section>
    </main>
  ),
};
