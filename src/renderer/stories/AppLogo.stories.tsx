import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { AppLogo, type AppLogoAnimation } from "../src/components/AppLogo";

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

export const AllAnimations: Story = {
  parameters: { controls: { exclude: ["animation"] } },
  render: (args) => (
    <div class="app-logo-gallery">
      {ANIMATIONS.map(({ animation, label }) => (
        <figure class="app-logo-gallery-item">
          <div class="app-logo-gallery-preview">
            <AppLogo variant={args.variant} animation={animation} class="app-logo-gallery-logo" />
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
