import { createSignal } from "solid-js";
import { expect, within } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Heading, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../src/components/ui";

const options = ["Low", "Medium", "High", "Extra high"];

const meta = {
  title: "Foundations/Select",
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function ReasoningSelect(props: { size?: "sm" | "md"; disabled?: boolean }) {
  const [value, setValue] = createSignal("Medium");
  return (
    <Select<string>
      options={options}
      value={value()}
      disabled={props.disabled}
      onChange={(next) => next && setValue(next)}
      itemComponent={(item) => <SelectItem item={item.item}>{item.item.rawValue}</SelectItem>}
    >
      <SelectTrigger size={props.size} aria-label="Reasoning level">
        <SelectValue<string>>{(state) => state.selectedOption()}</SelectValue>
      </SelectTrigger>
      <SelectContent />
    </Select>
  );
}

export const Gallery: Story = {
  render: () => (
    <main class="foundation-story">
      <Heading as="h1" size="lg">
        Selects
      </Heading>
      <div class="foundation-story-stack">
        <ReasoningSelect />
        <ReasoningSelect size="sm" />
        <ReasoningSelect disabled />
      </div>
    </main>
  ),
  play: async ({ canvas, userEvent }) => {
    const trigger = canvas.getAllByRole("button", { name: /Reasoning level/ })[0];
    await userEvent.click(trigger);
    const body = within(document.body);
    await userEvent.click(await body.findByRole("option", { name: "High" }));
    await expect(trigger).toHaveTextContent("High");
  },
};
