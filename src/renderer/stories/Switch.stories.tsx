import { createSignal } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Heading, Switch } from "../src/components/ui";

const meta = {
  title: "Foundations/Switch",
  component: Switch,
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta<typeof Switch>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Gallery: Story = {
  render: () => {
    const [checked, setChecked] = createSignal(false);
    return (
      <main class="foundation-story">
        <Heading as="h1" size="lg">
          Switches
        </Heading>
        <div class="foundation-story-stack">
          <Switch
            checked={checked()}
            onChange={setChecked}
            label="Desktop notifications"
            description="Receive updates when an agent finishes."
          />
          <Switch defaultChecked size="sm" label="Compact enabled" />
          <Switch disabled label="Disabled setting" />
        </div>
      </main>
    );
  },
};
