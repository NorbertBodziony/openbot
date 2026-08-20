import { AppLogo, type AppLogoAnimation } from "@openbot/brand";
import type { Meta, StoryObj } from "storybook-solidjs-vite";

const ANIMATIONS: Array<{ animation: AppLogoAnimation; label: string }> = [
  { animation: "blink", label: "Blink" },
  { animation: "look-around", label: "Look around" },
  { animation: "surprised", label: "Surprised" },
];

const meta = {
  title: "Brand/AppLogo",
  component: AppLogo,
  args: {
    variant: "production",
    animation: "blink",
    interactive: true,
  },
  argTypes: {
    variant: {
      control: "select",
      options: ["production", "dev", "preview"],
    },
    animation: {
      control: "select",
      options: ["none", "blink", "look-around", "surprised"],
    },
    interactive: {
      control: "boolean",
    },
  },
  parameters: { layout: "centered" },
  render: (args) => (
    <div class="account-login-brand">
      <AppLogo {...args} class="account-login-logo" />
    </div>
  ),
} satisfies Meta<typeof AppLogo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const InteractivePlayground: Story = {
  render: (args) => (
    <figure class="app-logo-gallery-item">
      <div class="app-logo-gallery-preview">
        <AppLogo {...args} class="app-logo-gallery-logo" />
      </div>
      <figcaption>Move the cursor · click to wink</figcaption>
    </figure>
  ),
};

export const AllAnimations: Story = {
  parameters: { controls: { exclude: ["animation"] } },
  render: (args) => (
    <div class="app-logo-gallery">
      {ANIMATIONS.map(({ animation, label }) => (
        <figure class="app-logo-gallery-item">
          <div class="app-logo-gallery-preview">
            <AppLogo
              variant={args.variant}
              animation={animation}
              interactive={args.interactive}
              class="app-logo-gallery-logo"
            />
          </div>
          <figcaption>{label}</figcaption>
        </figure>
      ))}
    </div>
  ),
};

export const Blink: Story = {};

export const LookAround: Story = {
  args: { animation: "look-around" },
};

export const Surprised: Story = {
  args: { animation: "surprised" },
};
