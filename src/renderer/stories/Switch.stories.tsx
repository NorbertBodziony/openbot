import { createSignal } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Heading, Switch, SwitchField } from "../src/components/ui";

const meta = {
  title: "Foundations/Switch",
  component: Switch,
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta<typeof Switch>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Gallery: Story = {
  args: {},
  render: () => {
    const [checked, setChecked] = createSignal(false);
    return (
      <main class="foundation-story">
        <Heading as="h1" size="lg">
          Switches
        </Heading>
        <div class="foundation-story-stack" style={{ "max-width": "440px" }}>
          <SwitchField
            checked={checked()}
            onChange={setChecked}
            label="Desktop notifications"
            description="Receive updates when an agent finishes."
          />
          <SwitchField defaultChecked size="sm" label="Compact enabled" />
          <SwitchField disabled label="Disabled setting" />
          <SwitchField validationState="invalid" label="Invalid setting" />
          <div style={{ display: "flex", "align-items": "center", gap: "16px" }}>
            <Switch aria-label="Default off" />
            <Switch defaultChecked aria-label="Default on" />
            <Switch size="sm" aria-label="Small off" />
            <Switch defaultChecked size="sm" aria-label="Small on" />
          </div>
        </div>
      </main>
    );
  },
};
