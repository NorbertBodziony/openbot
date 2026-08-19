import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { OtpInput } from "../src/components/OtpInput";

const meta = {
  title: "Auth/OtpInput",
  component: OtpInput,
  args: {
    value: "",
    status: "idle",
    hint: "Enter all 8 characters to continue.",
    errorMessage: null,
    successMessage: "Verified. Opening OpenBot…",
    onChange: fn(),
    onComplete: fn(),
  },
  decorators: [
    (Story) => (
      <main class="account-login-screen">
        <section class="account-login">
          <div class="account-login-form">
            <Story />
          </div>
        </section>
      </main>
    ),
  ],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof OtpInput>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Idle: Story = {};

export const PartiallyFilled: Story = {
  args: { value: "ABCD" },
};

export const Verifying: Story = {
  args: { value: "ABCDEFGH", status: "verifying" },
};

export const InvalidCode: Story = {
  args: {
    value: "ABCDEFGH",
    status: "error",
    errorMessage: "The sign-in code is incorrect.",
  },
};

export const ExpiredCode: Story = {
  args: {
    value: "ABCDEFGH",
    status: "error",
    errorMessage: "The sign-in code expired. Request a new code.",
    disabled: true,
  },
};

export const Success: Story = {
  args: { value: "ABCDEFGH", status: "success" },
};

export const Mobile390: Story = {
  args: { value: "ABCD" },
  parameters: {
    viewport: { defaultViewport: "mobile1" },
  },
};
