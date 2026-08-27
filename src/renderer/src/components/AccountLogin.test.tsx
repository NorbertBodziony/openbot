import type { CentralAuthState } from "@openbot/contracts/ipc";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { AccountLogin } from "./AccountLogin";

function codeSentState(overrides: Partial<Extract<CentralAuthState, { status: "code_sent" }>> = {}): CentralAuthState {
  const now = Date.now();
  return {
    status: "code_sent",
    challengeId: "challenge-1",
    email: "person@example.com",
    expiresAt: now + 600_000,
    resendAvailableAt: now + 60_000,
    ...overrides,
  };
}

function renderLogin(
  state: CentralAuthState = { status: "signed_out" },
  overrides: Partial<Parameters<typeof AccountLogin>[0]> = {},
) {
  const props: Parameters<typeof AccountLogin>[0] = {
    variant: "production",
    state,
    onRetry: vi.fn().mockResolvedValue(undefined),
    onRequestEmailCode: vi.fn().mockResolvedValue(undefined),
    onVerifyEmailCode: vi.fn().mockResolvedValue(undefined),
    onReset: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  const view = render(() => <AccountLogin {...props} />);
  return { ...view, props };
}

describe("AccountLogin", () => {
  it("renders a page-level sign-in form with an interactive brand logo", () => {
    renderLogin();

    expect(screen.getByRole("heading", { name: "Sign in to OpenBot" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Animate OpenBot logo" })).toBeInTheDocument();
  });

  it("validates and normalizes an email before requesting a code", async () => {
    const onRequestEmailCode = vi.fn().mockResolvedValue(undefined);
    renderLogin({ status: "signed_out" }, { onRequestEmailCode });
    const email = screen.getByRole("textbox", { name: "Email" });

    await fireEvent.input(email, { target: { value: "not-an-email" } });
    await fireEvent.click(screen.getByRole("button", { name: "Send sign-in code" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a valid email address.");
    expect(onRequestEmailCode).not.toHaveBeenCalled();

    await fireEvent.input(email, { target: { value: " Person.Name+tag@Example.COM " } });
    await fireEvent.click(screen.getByRole("button", { name: "Send sign-in code" }));
    expect(onRequestEmailCode).toHaveBeenCalledWith("person.name+tag@example.com");
  });

  it("shakes an invalid email and clears the error when the user types", async () => {
    const view = renderLogin();
    const email = screen.getByRole("textbox", { name: "Email" });

    await fireEvent.input(email, { target: { value: "not-an-email" } });
    await fireEvent.click(screen.getByRole("button", { name: "Send sign-in code" }));

    expect(email).toHaveClass("t-input", "is-error", "is-shaking");
    expect(view.container.querySelector(".t-input-wrap")).toHaveClass("is-error");
    expect(screen.getByRole("alert")).toHaveClass("t-error-msg");

    await fireEvent.input(email, { target: { value: "person@example.com" } });

    expect(email).not.toHaveClass("is-error");
    expect(email).not.toHaveClass("is-shaking");
    expect(view.container.querySelector(".t-input-wrap")).not.toHaveClass("is-error");
  });

  it("automatically reverts the email error after the hold time", async () => {
    vi.useFakeTimers();
    const view = renderLogin();

    try {
      const email = screen.getByRole("textbox", { name: "Email" });
      await fireEvent.input(email, { target: { value: "not-an-email" } });
      await fireEvent.click(screen.getByRole("button", { name: "Send sign-in code" }));

      expect(email).toHaveClass("is-error");
      await vi.advanceTimersByTimeAsync(3_300);

      expect(email).not.toHaveClass("is-error");
      expect(view.container.querySelector(".t-input-wrap")).not.toHaveClass("is-error");

      await vi.advanceTimersByTimeAsync(280);
      expect(view.container.querySelector(".t-error-msg")).toBeEmptyDOMElement();
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it("formats a pasted safe code and verifies it once automatically", async () => {
    let finishVerification: (() => void) | undefined;
    const onVerifyEmailCode = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishVerification = resolve;
        }),
    );
    renderLogin(codeSentState(), { onVerifyEmailCode });
    const code = screen.getByRole("textbox", { name: "One-time code" });

    await fireEvent.paste(code, { clipboardData: { getData: () => "abcd efgh" } });
    await fireEvent.input(code, { target: { value: "abcdefgh" } });

    expect(onVerifyEmailCode).toHaveBeenCalledOnce();
    expect(onVerifyEmailCode).toHaveBeenCalledWith("challenge-1", "ABCD-EFGH");
    finishVerification?.();
  });

  it("filters ambiguous characters without submitting an incomplete code", async () => {
    const onVerifyEmailCode = vi.fn().mockResolvedValue(undefined);
    renderLogin(codeSentState(), { onVerifyEmailCode });
    const code = screen.getByRole("textbox", { name: "One-time code" });

    await fireEvent.input(code, { target: { value: "ABCD-EF0I" } });

    expect(screen.getByText("Enter all 8 characters to continue.")).toBeInTheDocument();
    expect(document.querySelectorAll('.otp-input-slot[data-filled="true"]')).toHaveLength(6);
    expect(onVerifyEmailCode).not.toHaveBeenCalled();
  });

  it("keeps the challenge visible and requests a replacement for an expired code", async () => {
    const onRequestEmailCode = vi.fn().mockResolvedValue(undefined);
    renderLogin(
      codeSentState({
        expiresAt: Date.now() - 1_000,
        resendAvailableAt: Date.now() - 1_000,
        issue: { code: "sign_in_code_expired", message: "The sign-in code expired." },
      }),
      { onRequestEmailCode },
    );

    expect(screen.queryByText("Code expired")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("The sign-in code expired.");
    await fireEvent.click(screen.getByRole("button", { name: "Send a new code" }));
    expect(onRequestEmailCode).toHaveBeenCalledWith("person@example.com");
  });

  it("keeps the code input active after the local expiration time", async () => {
    vi.useFakeTimers();
    const onVerifyEmailCode = vi.fn().mockResolvedValue(undefined);
    const view = renderLogin(
      codeSentState({
        expiresAt: Date.now() + 1_000,
        resendAvailableAt: Date.now() - 1_000,
      }),
      { onVerifyEmailCode },
    );

    try {
      const input = screen.getByRole("textbox", { name: "One-time code" });
      await fireEvent.input(input, { target: { value: "ABCD" } });
      await vi.advanceTimersByTimeAsync(2_000);
      for (const key of "EFGH") await fireEvent.keyDown(input, { key });

      expect(input).not.toHaveAttribute("readonly");
      expect(view.container.querySelectorAll('.otp-input-slot[data-filled="true"]')).toHaveLength(8);
      expect(onVerifyEmailCode).toHaveBeenCalledWith("challenge-1", "ABCD-EFGH");
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it("exposes retry timing without allowing repeated requests", () => {
    renderLogin({
      status: "error",
      issue: {
        code: "rate_limited",
        message: "Too many sign-in attempts. Try again later.",
        retryAfterSeconds: 90,
      },
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Too many sign-in attempts");
    expect(screen.getByRole("button", { name: /Try again in 1:3\d/u })).toBeDisabled();
  });

  it("keeps a rate-limit countdown active while the email is edited", async () => {
    renderLogin({
      status: "error",
      issue: {
        code: "rate_limited",
        message: "Too many sign-in attempts. Try again later.",
        retryAfterSeconds: 90,
      },
    });

    await fireEvent.input(screen.getByRole("textbox", { name: "Email" }), {
      target: { value: "person@example.com" },
    });

    expect(screen.getByRole("button", { name: /Try again in 1:3\d/u })).toBeDisabled();
  });

  it("does not allow resend to overlap an in-flight verification", async () => {
    const onVerifyEmailCode = vi.fn(() => new Promise<void>(() => undefined));
    const onRequestEmailCode = vi.fn().mockResolvedValue(undefined);
    renderLogin(codeSentState({ resendAvailableAt: Date.now() - 1_000 }), {
      onVerifyEmailCode,
      onRequestEmailCode,
    });

    await fireEvent.input(screen.getByRole("textbox", { name: "One-time code" }), {
      target: { value: "ABCD-EFGH" },
    });

    expect(screen.getByRole("button", { name: "Resend code" })).toBeDisabled();
    expect(onRequestEmailCode).not.toHaveBeenCalled();
  });

  it("keeps resend unavailable for 60 seconds after a code is sent", async () => {
    const onRequestEmailCode = vi.fn().mockResolvedValue(undefined);
    renderLogin(codeSentState({ resendAvailableAt: Date.now() + 60_000 }), { onRequestEmailCode });

    const resend = screen.getByRole("button", { name: /Resend in (1:00|0:5\d)/u });
    expect(resend).toBeDisabled();
    await fireEvent.click(resend);
    expect(onRequestEmailCode).not.toHaveBeenCalled();
  });

  it("starts a newly issued resend countdown at exactly one minute", async () => {
    let currentTime = 1_000_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => currentTime);

    try {
      render(() => {
        const [state, setState] = createSignal<CentralAuthState>({ status: "signed_out" });
        return (
          <AccountLogin
            variant="production"
            state={state()}
            onRetry={async () => undefined}
            onRequestEmailCode={async (email) => {
              currentTime += 500;
              setState(codeSentState({ email, resendAvailableAt: currentTime + 60_000 }));
            }}
            onVerifyEmailCode={async () => undefined}
            onReset={async () => undefined}
          />
        );
      });

      await fireEvent.input(screen.getByRole("textbox", { name: "Email" }), {
        target: { value: "person@example.com" },
      });
      await fireEvent.click(screen.getByRole("button", { name: "Send sign-in code" }));

      expect(await screen.findByRole("button", { name: "Resend in 1:00" })).toBeDisabled();
    } finally {
      now.mockRestore();
    }
  });

  it("retries a changed complete code after an invalid-code response", async () => {
    const onVerifyEmailCode = vi.fn().mockResolvedValue(undefined);
    const state = codeSentState({
      issue: { code: "invalid_sign_in_code", message: "The sign-in code is incorrect." },
    });
    renderLogin(state, { onVerifyEmailCode });
    const input = screen.getByRole("textbox", { name: "One-time code" });

    await fireEvent.input(input, { target: { value: "ABCDEFGH" } });
    expect(onVerifyEmailCode).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the entered code after a verification network failure", async () => {
    const onVerifyEmailCode = vi.fn().mockRejectedValue(new Error("offline"));
    const view = renderLogin(codeSentState(), { onVerifyEmailCode });

    await fireEvent.input(screen.getByRole("textbox", { name: "One-time code" }), {
      target: { value: "ABCDEFGH" },
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong while verifying");
    expect(view.container.querySelectorAll('.otp-input-slot[data-filled="true"]')).toHaveLength(8);
  });

  it("offers a dedicated retry state when the account service is unavailable", async () => {
    const onRetry = vi.fn().mockResolvedValue(undefined);
    renderLogin(
      {
        status: "error",
        issue: { code: "auth_api_unavailable", message: "OpenBot could not reach the account service." },
      },
      { onRetry },
    );

    expect(screen.getByRole("heading", { name: "Service unavailable" })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(onRetry).toHaveBeenCalledOnce());
  });
});
