import type { CentralAuthState } from "@openbot/contracts/ipc";
import { createSignal } from "solid-js";
import { expect, fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { AccountLogin } from "../src/features/account/AccountLogin";

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

function codeSentState(overrides: Partial<Extract<CentralAuthState, { status: "code_sent" }>> = {}): CentralAuthState {
  const now = Date.now();
  return {
    status: "code_sent",
    challengeId: "challenge-story",
    email: "person@example.com",
    expiresAt: now + 600_000,
    resendAvailableAt: now + 60_000,
    ...overrides,
  };
}

export const SignIn: Story = {};

export const Interactive: Story = {
  render: (storyArgs) => {
    const [state, setState] = createSignal<CentralAuthState>({ status: "signed_out" });
    return (
      <AccountLogin
        {...storyArgs}
        state={state()}
        onRetry={async () => {
          setState({ status: "signed_out" });
        }}
        onRequestEmailCode={async (email) => {
          await delay(500);
          setState(
            codeSentState({
              challengeId: `challenge-${Date.now()}`,
              email,
              developmentCode: "ABCD-EFGH",
            }),
          );
        }}
        onVerifyEmailCode={async (_challengeId, code) => {
          const activeState = state();
          if (activeState.status !== "code_sent") return;
          await delay(650);
          if (code === "ABCD-EFGH") {
            setState({
              status: "signed_in",
              user: { id: "story-user", email: activeState.email, name: null, avatarUrl: null },
            });
            return;
          }
          setState({
            ...activeState,
            issue: { code: "invalid_sign_in_code", message: "The sign-in code is incorrect." },
          });
        }}
        onReset={async () => {
          await delay(250);
          setState({ status: "signed_out" });
        }}
      />
    );
  },
  parameters: {
    docs: {
      description: {
        story: "Use ABCD-EFGH to complete the simulated sign-in. Any other complete code shows the error state.",
      },
    },
  },
};

export const HappyPath: Story = {
  render: (storyArgs) => {
    const [state, setState] = createSignal(storyArgs.state);
    return (
      <AccountLogin
        {...storyArgs}
        state={state()}
        onRequestEmailCode={async (email) => {
          setState(codeSentState({ email }));
        }}
        onVerifyEmailCode={async () => {
          setState({
            status: "signed_in",
            user: { id: "story-user", email: "person@example.com", name: null, avatarUrl: null },
          });
        }}
      />
    );
  },
  play: async ({ canvas, userEvent }) => {
    await userEvent.type(canvas.getByLabelText("Email"), "Person@Example.com");
    await userEvent.click(canvas.getByRole("button", { name: "Send sign-in code" }));
    await expect(canvas.getByRole("heading", { name: "Check your inbox" })).toBeInTheDocument();
    await expect(canvas.getByText(/person@example.com/)).toBeInTheDocument();
    await userEvent.type(canvas.getByRole("textbox", { name: "One-time code" }), "ABCDEFGH");
    await expect(canvas.getByText("Verified. Opening OpenBot…")).toBeInTheDocument();
  },
};

export const SendingCode: Story = {
  args: { state: { status: "signing_in" } },
};

export const InvalidEmail: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.type(canvas.getByLabelText("Email"), "not-an-email");
    await userEvent.click(canvas.getByRole("button", { name: "Send sign-in code" }));
    await expect(canvas.getByRole("alert")).toHaveTextContent("Enter a valid email address.");
  },
};

export const CodeSent: Story = {
  args: { state: codeSentState() },
};

export const InvalidCode: Story = {
  args: {
    state: codeSentState({
      issue: { code: "invalid_sign_in_code", message: "The sign-in code is incorrect." },
    }),
  },
};

export const ExpiredCode: Story = {
  args: {
    state: codeSentState({
      expiresAt: Date.now() - 1_000,
      resendAvailableAt: Date.now() - 1_000,
      issue: { code: "sign_in_code_expired", message: "The sign-in code expired." },
    }),
  },
};

export const ResendRateLimited: Story = {
  args: {
    state: codeSentState({
      resendAvailableAt: Date.now() + 42_000,
      issue: {
        code: "code_recently_sent",
        message: "Wait 42 seconds before requesting another code.",
        retryAfterSeconds: 42,
      },
    }),
  },
};

export const Connecting: Story = {
  args: { state: { status: "loading" }, onRetry: fn() },
};

export const ServiceUnavailable: Story = {
  args: {
    state: {
      status: "error",
      issue: {
        code: "auth_api_unavailable",
        message: "OpenBot could not reach the account service. Check your connection and try again.",
      },
    },
  },
};

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
