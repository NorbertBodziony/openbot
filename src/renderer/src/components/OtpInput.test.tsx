import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OtpInput, type OtpInputStatus } from "./OtpInput";

const originalMatchMedia = window.matchMedia;

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  vi.restoreAllMocks();
});

function renderOtp(options: { value?: string; status?: OtpInputStatus; autofocus?: boolean } = {}) {
  const onChange = vi.fn();
  const onComplete = vi.fn();
  const view = render(() => (
    <OtpInput
      value={options.value ?? ""}
      status={options.status}
      autofocus={options.autofocus}
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
  it("renders eight fixed slots and filters paste through the OpenBot alphabet", async () => {
    const { input, slots, onChange, onComplete } = renderOtp();

    expect(slots()).toHaveLength(8);
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

  it("accepts native one-time-code autofill and submits only once", async () => {
    const { input, onComplete } = renderOtp();

    await fireEvent.input(input, { target: { value: "abcd-efgh" } });
    await fireEvent.input(input, { target: { value: "" } });

    expect(onComplete).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith("ABCDEFGH");
  });

  it("supports slot clicks, arrows, Home, End, Delete, and fixed middle holes", async () => {
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

  it("focuses the exact slot selected with a pointer", async () => {
    const { input, slots } = renderOtp({ value: "AB" });
    slots().forEach((slot, index) => {
      vi.spyOn(slot, "getBoundingClientRect").mockReturnValue({
        bottom: 50,
        height: 50,
        left: index * 40,
        right: index * 40 + 34,
        top: 0,
        width: 34,
        x: index * 40,
        y: 0,
        toJSON: () => undefined,
      });
    });

    await fireEvent.pointerDown(input, { clientX: 297 });
    await fireEvent.keyDown(input, { key: "C" });

    expect(slots()[2]?.textContent).toBe("");
    expect(slots()[7]).toHaveTextContent("C");
  });

  it("keeps focus on the last slot while verification is pending", async () => {
    render(() => {
      const [value, setValue] = createSignal("");
      const [status, setStatus] = createSignal<OtpInputStatus>("idle");
      return (
        <OtpInput value={value()} status={status()} onChange={setValue} onComplete={() => setStatus("verifying")} />
      );
    });
    const input = screen.getByRole("textbox", { name: "One-time code" });

    input.focus();
    await fireEvent.input(input, { target: { value: "ABCDEFGH" } });

    expect(input).not.toHaveAttribute("readonly");
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

  it("shows success feedback and respects reduced motion for error shake", () => {
    const animate = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
    window.matchMedia = vi.fn().mockReturnValue({ matches: true });

    const errorView = renderOtp({ value: "ABCDEFGH", status: "error" });
    expect(screen.getByRole("alert")).toHaveTextContent("That code is incorrect");
    expect(animate).not.toHaveBeenCalled();
    errorView.unmount();

    renderOtp({ value: "ABCDEFGH", status: "success" });
    const message = screen.getByRole("status");
    expect(message).toHaveTextContent("Verified. Opening OpenBot…");
  });
});
