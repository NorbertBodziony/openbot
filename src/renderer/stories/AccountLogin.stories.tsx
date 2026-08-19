import type { CentralAuthState } from "@openbot/contracts/ipc";
import { createSignal } from "solid-js";
import { expect, fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { AccountLogin } from "../src/components/AccountLogin";

const signedOut: CentralAuthState = { status: "signed_out" };

const args: Parameters<typeof AccountLogin>[0] = {
  variant: "production",
  state: signedOut,
  onRetry: async () => undefined,
  onRequestEmailCode: async () => undefined,
  onVerifyEmailCode: async () => undefined,
  onReset: async () => undefined,
};

const meta = {
  title: "Auth/AccountLogin",
  component: AccountLogin,
  args,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof AccountLogin>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SignIn: Story = {
  render: (storyArgs) => {
    const [state, setState] = createSignal(storyArgs.state);
    return (
      <AccountLogin
        {...storyArgs}
        state={state()}
        onRequestEmailCode={async (email) => {
          setState({
            status: "code_sent",
            challengeId: "challenge-story",
            email,
            expiresAt: Date.now() + 600_000,
          });
        }}
      />
    );
  },
  play: async ({ canvas, userEvent }) => {
    await userEvent.type(canvas.getByLabelText("Email"), "person@example.com");
    await userEvent.click(canvas.getByRole("button", { name: "Continue" }));
    await expect(canvas.getByRole("heading", { name: "Check your email" })).toBeInTheDocument();
  },
};

export const CodeSent: Story = {
  args: {
    state: {
      status: "code_sent",
      challengeId: "challenge-story",
      email: "person@example.com",
      expiresAt: Date.now() + 600_000,
    },
  },
};

export const Connecting: Story = {
  args: { state: { status: "loading" }, onRetry: fn() },
};

export const ErrorState: Story = {
  args: {
    state: {
      status: "error",
      code: "auth_api_unavailable",
      message: "The account service did not become available in time.",
    },
  },
};
