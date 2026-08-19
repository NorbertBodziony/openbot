import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import {
  Badge,
  Button,
  Card,
  Field,
  Heading,
  IconButton,
  Input,
  Kbd,
  NativeSelect,
  Separator,
  Skeleton,
  Spinner,
  Switch,
  Text,
  Textarea,
} from ".";

describe("UI primitives", () => {
  it("forwards button events and exposes disabled and loading states", async () => {
    const onClick = vi.fn();
    const { unmount } = render(() => <Button onClick={onClick}>Continue</Button>);
    await fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onClick).toHaveBeenCalledOnce();
    unmount();

    render(() => (
      <Button loading loadingLabel="Saving">
        Save
      </Button>
    ));
    const loading = screen.getByRole("button", { name: "Saving" });
    expect(loading).toBeDisabled();
    expect(loading).toHaveAttribute("aria-busy", "true");
  });

  it("exposes button variants, sizes, layout, and native props", () => {
    render(() => (
      <Button variant="danger" size="lg" fullWidth name="action" value="remove">
        Remove
      </Button>
    ));
    const button = screen.getByRole("button", { name: "Remove" });
    expect(button).toHaveAttribute("data-variant", "danger");
    expect(button).toHaveAttribute("data-size", "lg");
    expect(button).toHaveClass("ui-button-full");
    expect(button).toHaveAttribute("name", "action");
    expect(button).toHaveAttribute("value", "remove");
  });

  it("requires an accessible icon button label", () => {
    render(() => (
      <IconButton label="Close">
        <span aria-hidden="true">×</span>
      </IconButton>
    ));
    expect(screen.getByRole("button", { name: "Close" })).toHaveAttribute("title", "Close");
  });

  it("renders semantic badge variants without changing the content", () => {
    render(() => (
      <Badge tone="success" shape="pill" dot>
        Connected
      </Badge>
    ));
    const badge = screen.getByText("Connected");
    expect(badge).toHaveAttribute("data-tone", "success");
    expect(badge).toHaveAttribute("data-shape", "pill");
    expect(badge.querySelector(".ui-badge-dot")).toBeInTheDocument();
  });

  it("supports controlled switch state and form-compatible input props", async () => {
    const [checked, setChecked] = createSignal(false);
    render(() => (
      <form>
        <Switch
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

  it("supports an uncontrolled required switch", async () => {
    render(() => <Switch defaultChecked required aria-label="Required option" />);
    const control = screen.getByRole("switch", { name: "Required option" });
    expect(control).toBeChecked();
    expect(control).toBeRequired();
    await fireEvent.click(control);
    expect(control).not.toBeChecked();
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
        <Switch defaultChecked name="notifications" value="enabled" label="Notifications" />
      </form>
    ));

    const form = screen.getByRole("switch", { name: "Notifications" }).closest("form");
    if (!(form instanceof HTMLFormElement)) throw new Error("Expected the switch to be rendered inside a form.");
    await fireEvent.submit(form);
    expect(submitted?.get("notifications")).toBe("enabled");

    const control = screen.getByRole("switch", { name: "Notifications" });
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

  it("renders semantic typography, form, and surface primitives", () => {
    render(() => (
      <>
        <Heading as="h2" size="lg">
          Foundation
        </Heading>
        <Text as="p" variant="caption" tone="muted" truncate>
          Supporting copy
        </Text>
        <NativeSelect aria-label="Provider" name="provider">
          <option value="openai">OpenAI</option>
        </NativeSelect>
        <Card aria-label="Status card">
          <Spinner label="Loading status" />
          <Skeleton />
          <Kbd>⌘K</Kbd>
        </Card>
        <Separator aria-label="Section break" />
      </>
    ));

    expect(screen.getByRole("heading", { level: 2, name: "Foundation" })).toHaveAttribute("data-size", "lg");
    expect(screen.getByText("Supporting copy")).toHaveClass("ui-text-truncate");
    expect(screen.getByLabelText("Provider")).toHaveAttribute("name", "provider");
    expect(screen.getByRole("status", { name: "Loading status" })).toBeInTheDocument();
    expect(document.querySelector(".ui-skeleton")).toBeInTheDocument();
    expect(screen.getByText("⌘K")).toHaveClass("ui-kbd");
    expect(screen.getByRole("separator", { name: "Section break" })).toBeInTheDocument();
  });
});
