import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { ProviderPicker, type ProviderPickerOption } from "../src/components/ProviderPicker";

const options: ProviderPickerOption[] = [
  {
    id: "codex",
    name: "Codex",
    state: "available",
    email: "person@example.com",
  },
  {
    id: "claude",
    name: "Claude",
    state: "sign-in-required",
    email: "person@example.com",
    message: "Sign in to Claude to use this provider.",
  },
];

const args: Parameters<typeof ProviderPicker>[0] = {
  value: "codex",
  options,
  ariaLabel: "Default provider",
  label: "Default provider",
  hint: "You can change this later in settings.",
  onChange: fn(),
};

const meta = {
  title: "Setup/ProviderPicker",
  component: ProviderPicker,
  args,
  parameters: { layout: "centered" },
} satisfies Meta<typeof ProviderPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Available: Story = {};

export const Embedded: Story = {
  args: { embedded: true, label: undefined },
};

export const ProviderUnavailable: Story = {
  args: {
    value: null,
    options: options.map((option) => ({
      ...option,
      state: "not-installed",
      message: "Install this provider to continue.",
    })),
  },
};

export const AllowUnavailableSelection: Story = {
  args: {
    value: "claude",
    allowUnavailableSelection: true,
  },
};
