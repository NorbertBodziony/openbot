import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Button,
  CopyButton,
  Field,
  IconButton,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SwitchField,
  Textarea,
  Toaster,
  toast,
} from "./index";

const originalClipboard = navigator.clipboard;

afterEach(() => {
  toast.dismiss();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: originalClipboard });
});

describe("UI primitives", () => {
  it("announces a toast and runs its action", async () => {
    const onUndo = vi.fn();
    render(() => <Toaster />);

    toast.success("Event created", {
      description: "The agent is ready.",
      action: { label: "Undo", onClick: onUndo },
    });

    expect(await screen.findByRole("region", { name: /Notifications/ })).toHaveAttribute("aria-live", "polite");
    expect(await screen.findByText("Event created")).toBeInTheDocument();
    expect(screen.getByText("The agent is ready.")).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(onUndo).toHaveBeenCalledOnce();
  });

  it("dismisses a toast with its accessible close button", async () => {
    render(() => <Toaster />);

    toast("Workspace synchronized");

    expect(await screen.findByText("Workspace synchronized")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Close notification" }));
    await waitFor(() => expect(screen.queryByText("Workspace synchronized")).not.toBeInTheDocument());
  });

  it("forwards button events and exposes disabled and loading states", async () => {
    const onClick = vi.fn();
    const { unmount } = render(() => <Button onClick={onClick}>Continue</Button>);
    await fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onClick).toHaveBeenCalledOnce();
    unmount();

    const loadingClick = vi.fn();
    render(() => (
      <Button loading loadingLabel="Saving" onClick={loadingClick}>
        Save
      </Button>
    ));
    const loading = screen.getByRole("button", { name: "Saving" });
    expect(loading).toBeDisabled();
    expect(loading).toHaveAttribute("aria-busy", "true");
    await fireEvent.click(loading);
    expect(loadingClick).not.toHaveBeenCalled();
  });

  it("copies a value and resets its success state after 1.5 seconds", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(() => <CopyButton value="https://openbot.example/invite" label="Copy link" />);

    await fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await vi.runAllTicks();

    expect(writeText).toHaveBeenCalledWith("https://openbot.example/invite");
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(1_500);
    expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
  });

  it("reports clipboard failures without showing a stale success state", async () => {
    const clipboardError = new Error("Clipboard unavailable");
    const onCopyError = vi.fn();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => Promise.reject(clipboardError)) },
    });
    render(() => <CopyButton value="server-address" label="Copy address" onCopyError={onCopyError} />);

    await fireEvent.click(screen.getByRole("button", { name: "Copy address" }));

    await waitFor(() => expect(onCopyError).toHaveBeenCalledWith(clipboardError));
  });

  it("keeps forwarded loading state reactive", async () => {
    const [loading, setLoading] = createSignal(false);
    render(() => <Button loading={loading()}>Sync</Button>);

    const button = screen.getByRole("button", { name: "Sync" });
    expect(button).not.toBeDisabled();

    setLoading(true);
    await flush();

    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
  });

  it("requires an accessible icon button label", () => {
    render(() => (
      <IconButton label="Close">
        <span aria-hidden="true">×</span>
      </IconButton>
    ));
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("supports controlled switch state and form-compatible input props", async () => {
    const [checked, setChecked] = createSignal(false);
    render(() => (
      <form>
        <SwitchField
          checked={checked()}
          onChange={setChecked}
          name="notifications"
          value="enabled"
          label="Notifications"
          description="Get an update when work finishes."
        />
      </form>
    ));

    const control = screen.getByRole("switch", { name: "Notifications" });
    expect(control).not.toBeChecked();
    await fireEvent.click(control);
    expect(checked()).toBe(true);
    expect(control).toBeChecked();
    expect(control).toHaveAttribute("name", "notifications");
    expect(control).toHaveAttribute("value", "enabled");
  });

  it("exposes invalid switch state and field description", async () => {
    render(() => (
      <SwitchField
        id="invalid-option"
        validationState="invalid"
        label="Invalid option"
        description="Choose a valid value."
      />
    ));

    const invalid = screen.getByRole("switch", { name: "Invalid option" });
    expect(invalid).toHaveAttribute("aria-invalid", "true");
    expect(invalid).toHaveAttribute("aria-describedby", "invalid-option-description");

    const label = screen.getByText("Invalid option");
    await fireEvent.click(label);
    expect(invalid).toBeChecked();
  });

  it("supports a controlled accessible select", async () => {
    const [value, setValue] = createSignal("medium");
    const options = ["low", "medium", "high"];
    render(() => (
      <Select<string>
        options={options}
        value={value()}
        onChange={(next) => next && setValue(next)}
        itemComponent={(item) => <SelectItem item={item.item}>{item.item.rawValue}</SelectItem>}
      >
        <SelectTrigger aria-label="Reasoning">
          <SelectValue<string>>{(state) => state.selectedOption()}</SelectValue>
        </SelectTrigger>
        <SelectContent />
      </Select>
    ));

    const trigger = screen.getByRole("button", { name: /Reasoning/ });
    expect(trigger).toHaveTextContent("medium");
    await fireEvent.pointerDown(trigger, { pointerType: "mouse", button: 0 });
    await fireEvent.click(screen.getByRole("option", { name: "high" }));
    expect(value()).toBe("high");
    expect(trigger).toHaveTextContent("high");
  });

  it("submits and resets an uncontrolled switch through its native form input", async () => {
    let submitted: FormData | undefined;
    render(() => (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submitted = new FormData(event.currentTarget);
        }}
      >
        <SwitchField defaultChecked required name="notifications" value="enabled" label="Notifications" />
      </form>
    ));

    const form = screen.getByRole("switch", { name: "Notifications" }).closest("form");
    if (!(form instanceof HTMLFormElement)) throw new Error("Expected the switch to be rendered inside a form.");
    await fireEvent.submit(form);
    expect(submitted?.get("notifications")).toBe("enabled");

    const control = screen.getByRole("switch", { name: "Notifications" });
    expect(control).toBeRequired();
    await fireEvent.click(control);
    expect(control).not.toBeChecked();
    await fireEvent.reset(form);
    expect(control).toBeChecked();
  });

  it("associates labels with text controls and forwards native props", () => {
    render(() => (
      <>
        <Field label="Agent name" htmlFor="agent-name" required description="Shown in the sidebar.">
          <Input id="agent-name" name="agentName" placeholder="Researcher" />
        </Field>
        <Field label="Instructions" htmlFor="instructions" error="Required">
          <Textarea id="instructions" invalid />
        </Field>
      </>
    ));

    expect(screen.getByLabelText(/Agent name/)).toHaveAttribute("name", "agentName");
    expect(screen.getByLabelText(/Agent name/)).toHaveAttribute("aria-describedby");
    expect(screen.getByLabelText("Instructions")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Instructions")).toHaveAttribute("aria-describedby");
    expect(screen.getByRole("alert")).toHaveTextContent("Required");
  });

  it("keeps reactive values and every character from one native typing burst", () => {
    const [name, setName] = createSignal("");
    const [description, setDescription] = createSignal("");
    render(() => (
      <>
        <Input aria-label="Burst name" value={name()} onValueChange={setName} />
        <Textarea aria-label="Burst description" value={description()} onValueChange={setDescription} />
      </>
    ));

    const nameInput = screen.getByRole("textbox", { name: "Burst name" });
    const descriptionInput = screen.getByRole("textbox", { name: "Burst description" });
    if (!(nameInput instanceof HTMLInputElement)) throw new Error("Expected a native input.");
    if (!(descriptionInput instanceof HTMLTextAreaElement)) throw new Error("Expected a native textarea.");

    flush(() => {
      setName("external name");
      setDescription("external description");
    });
    expect(nameInput).toHaveValue("external name");
    expect(descriptionInput).toHaveValue("external description");
    flush(() => {
      setName("");
      setDescription("");
    });

    for (const character of "abcdefghijklmnop") {
      nameInput.setRangeText(character, nameInput.value.length, nameInput.value.length, "end");
      nameInput.dispatchEvent(new InputEvent("input", { bubbles: true, data: character, inputType: "insertText" }));
    }
    for (const character of "fast description") {
      descriptionInput.setRangeText(character, descriptionInput.value.length, descriptionInput.value.length, "end");
      descriptionInput.dispatchEvent(
        new InputEvent("input", { bubbles: true, data: character, inputType: "insertText" }),
      );
    }

    expect(nameInput).toHaveValue("abcdefghijklmnop");
    expect(descriptionInput).toHaveValue("fast description");
  });
});
