import { fireEvent, render, screen, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { OtpInput, type OtpInputStatus } from "./OtpInput";

function renderOtp(options: { value?: string; status?: OtpInputStatus } = {}) {
  const onChange = vi.fn();
  const onComplete = vi.fn();
  const view = render(() => (
    <OtpInput
      value={options.value ?? ""}
      status={options.status}
      hint="Enter all 8 characters to continue."
      onChange={onChange}
      onComplete={onComplete}
    />
  ));
  const input = screen.getByRole("textbox", { name: "One-time code" });
  const slots = () => [...view.container.querySelectorAll<HTMLElement>(".otp-input-slot")];
  return { ...view, input, slots, onChange, onComplete };
}

describe("OtpInput", () => {
  it("filters paste through the OpenBot alphabet", async () => {
    const { input, slots, onChange, onComplete } = renderOtp();

    await fireEvent.paste(input, {
      clipboardData: { getData: () => "ab0i-cdefgh" },
    });

    expect(
      slots()
        .map((slot) => slot.textContent)
        .join(""),
    ).toBe("ABCDEFGH");
    expect(onChange).toHaveBeenLastCalledWith("ABCDEFGH");
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("keeps the entered characters inside a group named for the code", async () => {
    // The native input is cleared on every keystroke, so these characters are
    // the only copy of the code in the accessibility tree. The group's name is
    // what tells a screen reader what they are - and what lets
    // `dev:automation` recognize the subtree it must not print into an agent
    // transcript, which is why the name is a contract rather than decoration.
    const { input } = renderOtp();

    await fireEvent.paste(input, { clipboardData: { getData: () => "ABCDEFGH" } });

    const digits = within(screen.getByRole("group", { name: "One-time code entry" }));
    expect(digits.getByText("A")).toBeInTheDocument();
    expect(digits.getByText("H")).toBeInTheDocument();
  });

  it("accepts native one-time-code autofill and submits only once", async () => {
    const { input, onComplete } = renderOtp();

    await fireEvent.input(input, { target: { value: "abcd-efgh" } });
    await fireEvent.input(input, { target: { value: "" } });

    expect(onComplete).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith("ABCDEFGH");
  });

  it("supports arrows, Home, End, Delete, and fixed middle holes", async () => {
    const { input, slots, onComplete } = renderOtp({ value: "ABCDEFGH" });
    await fireEvent.focus(input);
    await fireEvent.keyDown(input, { key: "Home" });
    await fireEvent.keyDown(input, { key: "ArrowRight" });
    await fireEvent.keyDown(input, { key: "ArrowRight" });
    await fireEvent.keyDown(input, { key: "Delete" });

    expect(slots()[2]?.textContent).toBe("");
    expect(slots()[3]).toHaveTextContent("D");

    onComplete.mockClear();
    await fireEvent.keyDown(input, { key: "Z" });
    expect(
      slots()
        .map((slot) => slot.textContent)
        .join(""),
    ).toBe("ABZDEFGH");
    expect(onComplete).toHaveBeenCalledWith("ABZDEFGH");

    await fireEvent.keyDown(input, { key: "End" });
    await fireEvent.keyDown(input, { key: "Backspace" });
    expect(slots()[7]?.textContent).toBe("");
  });

  it("resets its fixed slots when the controlled value is cleared", async () => {
    const onComplete = vi.fn();
    render(() => {
      const [value, setValue] = createSignal("ABCDEFGH");
      return (
        <>
          <OtpInput value={value()} onChange={setValue} onComplete={onComplete} />
          <button type="button" onClick={() => setValue("")}>
            Reset
          </button>
        </>
      );
    });

    await fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.getByRole("textbox", { name: "One-time code" })).toHaveValue("");
  });

  it("announces the incorrect code and the verified result", () => {
    const errorView = renderOtp({ value: "ABCDEFGH", status: "error" });
    expect(screen.getByRole("alert")).toHaveTextContent("That code is incorrect");
    errorView.unmount();

    renderOtp({ value: "ABCDEFGH", status: "success" });
    const message = screen.getByRole("status");
    expect(message).toHaveTextContent("Verified. Opening OpenBot…");
  });
});
