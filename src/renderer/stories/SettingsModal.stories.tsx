import { createSignal } from "solid-js";
import { expect, waitFor, within } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { SettingsModal } from "../src/components/SettingsModal";
import { Button, Heading, Text } from "../src/components/ui";

function SettingsModalStory(props: { initialOpen: boolean }) {
  const [open, setOpen] = createSignal(props.initialOpen);

  return (
    <main class="foundation-story foundation-interaction-stage">
      <Heading as="h1" size="lg">
        Workspace settings
      </Heading>
      <Text tone="secondary">Preview the standalone settings surface before it is connected to the app.</Text>
      <Button variant="outline" type="button" onClick={() => setOpen(true)}>
        Open settings
      </Button>
      <SettingsModal open={open()} onOpenChange={setOpen} />
    </main>
  );
}

const meta = {
  title: "Settings/SettingsModal",
  component: SettingsModal,
  args: { open: false, onOpenChange: () => undefined },
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta<typeof SettingsModal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {
  render: () => <SettingsModalStory initialOpen />,
};

export const Interactive: Story = {
  render: () => <SettingsModalStory initialOpen={false} />,
  play: async ({ canvas, userEvent }) => {
    const body = within(document.body);
    const trigger = canvas.getByRole("button", { name: "Open settings" });

    await userEvent.click(trigger);
    let dialog = await body.findByRole("dialog", { name: "General" });
    await waitFor(() => expect(dialog).toBeVisible());
    await expect(body.getByTestId("settings-modal-scroll-frame")).toHaveAttribute("data-scroll-down");
    await expect(body.getByRole("button", { name: "Appearance" })).toBeDisabled();
    await expect(body.getByRole("button", { name: "Notifications" })).toBeDisabled();
    await expect(body.getByRole("button", { name: "Advanced" })).toBeDisabled();

    const profileTab = body.getByRole("button", { name: "Profile" });
    await userEvent.click(profileTab);
    await expect(profileTab).toHaveAttribute("aria-current", "page");
    await expect(body.getByRole("heading", { name: "Profile", level: 2 })).toBeVisible();
    await expect(body.getByRole("textbox", { name: "Display name" })).toHaveValue("OpenBot user");

    const generalTab = body.getByRole("button", { name: "General" });
    await userEvent.click(generalTab);
    await expect(generalTab).toHaveAttribute("aria-current", "page");

    const linkTarget = body.getByRole("button", { name: /Open external links in/ });
    await userEvent.click(linkTarget);
    await waitFor(() => expect(body.getByRole("listbox")).toBeVisible());
    await userEvent.click(body.getByRole("option", { name: "OpenBot" }));
    await expect(linkTarget).toHaveTextContent("OpenBot");

    const launchSwitch = body.getByRole("switch", { name: "Launch OpenBot at login" });
    await expect(launchSwitch).toBeChecked();
    await userEvent.click(launchSwitch);
    await expect(launchSwitch).not.toBeChecked();

    await userEvent.click(body.getByRole("button", { name: "Close settings" }));
    await expect(dialog).toHaveAttribute("data-motion", "closing");
    await waitFor(() => expect(body.queryByRole("dialog", { name: "General" })).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());

    await userEvent.click(trigger);
    dialog = await body.findByRole("dialog", { name: "General" });
    await waitFor(() => expect(dialog).toBeVisible());
    await userEvent.keyboard("{Escape}");
    await expect(dialog).toHaveAttribute("data-motion", "closing");
    await waitFor(() => expect(body.queryByRole("dialog", { name: "General" })).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());

    await userEvent.click(trigger);
    await body.findByRole("dialog", { name: "General" });
    await userEvent.click(body.getByTestId("settings-modal-backdrop"));
    await waitFor(() => expect(body.queryByRole("dialog", { name: "General" })).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  },
};
