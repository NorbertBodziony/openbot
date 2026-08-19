import type { CentralAuthState } from "@openbot/contracts/ipc";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
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
  it("renders a page-level sign-in form with a decorative brand logo", () => {
    const view = renderLogin();

    expect(screen.getByRole("heading", { name: "Sign in to OpenBot" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(view.container.querySelector(".account-login-logo")).toHaveAttribute("aria-hidden", "true");
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

  it("formats a pasted safe code and verifies it once", async () => {
    let finishVerification: (() => void) | undefined;
    const onVerifyEmailCode = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishVerification = resolve;
        }),
    );
    renderLogin(codeSentState(), { onVerifyEmailCode });
    const code = screen.getByRole("textbox", { name: "One-time code" });

    await fireEvent.input(code, { target: { value: "abcd efgh" } });
    expect(code).toHaveValue("ABCD-EFGH");
    await fireEvent.click(screen.getByRole("button", { name: "Verify code" }));
    await fireEvent.click(screen.getByRole("button", { name: "Verifying…" }));

    expect(onVerifyEmailCode).toHaveBeenCalledOnce();
    expect(onVerifyEmailCode).toHaveBeenCalledWith("challenge-1", "ABCD-EFGH");
    finishVerification?.();
  });

  it("rejects incomplete or ambiguous one-time codes locally", async () => {
    const onVerifyEmailCode = vi.fn().mockResolvedValue(undefined);
    renderLogin(codeSentState(), { onVerifyEmailCode });
    const code = screen.getByRole("textbox", { name: "One-time code" });

    await fireEvent.input(code, { target: { value: "ABCD-EF0I" } });
    expect(code).toHaveValue("ABCD-EF");
    await fireEvent.click(screen.getByRole("button", { name: "Verify code" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Enter the full 8-character code.");
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

    expect(screen.getByText("Code expired")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Send a new code" }));
    expect(onRequestEmailCode).toHaveBeenCalledWith("person@example.com");
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
