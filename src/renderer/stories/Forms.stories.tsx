import { createSignal } from "solid-js";
import { expect } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Button, Field, Heading, Input, NativeSelect, Textarea } from "../src/components/ui";

const meta = {
  title: "Foundations/Forms",
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Gallery: Story = {
  render: () => (
    <main class="foundation-story">
      <Heading as="h1" size="lg">
        Form controls
      </Heading>
      <form class="foundation-form">
        <Field
          label="Agent name"
          htmlFor="foundation-name"
          description="Visible to everyone in the workspace."
          required
        >
          <Input id="foundation-name" name="name" placeholder="Research agent" required />
        </Field>
        <Field label="Provider" htmlFor="foundation-provider">
          <NativeSelect id="foundation-provider" name="provider">
            <option>OpenAI</option>
            <option>Anthropic</option>
          </NativeSelect>
        </Field>
        <Field label="Instructions" htmlFor="foundation-instructions">
          <Textarea id="foundation-instructions" name="instructions" placeholder="Describe the agent’s role…" />
        </Field>
        <Field label="Invalid example" htmlFor="foundation-invalid" error="This field needs attention.">
          <Input id="foundation-invalid" invalid value="Invalid value" />
        </Field>
        <Button type="submit" variant="primary">
          Save agent
        </Button>
      </form>
    </main>
  ),
};

export const ControlledTyping: Story = {
  render: () => {
    const [name, setName] = createSignal("");
    const [description, setDescription] = createSignal("");
    return (
      <main class="foundation-story">
        <Heading as="h1" size="lg">
          Controlled text fields
        </Heading>
        <Field label="Agent name" htmlFor="controlled-agent-name">
          <Input id="controlled-agent-name" value={name()} onValueChange={setName} />
        </Field>
        <Field label="Description" htmlFor="controlled-agent-description">
          <Textarea id="controlled-agent-description" value={description()} onValueChange={setDescription} />
        </Field>
      </main>
    );
  },
  play: async ({ canvas, userEvent }) => {
    const name = canvas.getByRole("textbox", { name: "Agent name" });
    const description = canvas.getByRole("textbox", { name: "Description" });
    await userEvent.type(name, "Fast typing stays intact");
    await userEvent.type(description, "Every character remains editable.");
    await expect(name).toHaveValue("Fast typing stays intact");
    await expect(description).toHaveValue("Every character remains editable.");
  },
};
