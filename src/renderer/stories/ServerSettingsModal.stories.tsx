import { createSignal } from "solid-js";
import { expect, fireEvent, waitFor, within } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { ServerSettingsModal } from "../src/components/ServerSettingsModal";
import { Button, Heading, Text } from "../src/components/ui";

function ServerSettingsModalStory(props: { initialOpen: boolean }) {
  const [open, setOpen] = createSignal(props.initialOpen);

  return (
    <main class="foundation-story foundation-interaction-stage">
      <Heading as="h1" size="lg">
        Server settings
      </Heading>
      <Text tone="secondary">Preview server publishing, invitations, and member access.</Text>
      <Button type="button" onClick={() => setOpen(true)}>
        Open server settings
      </Button>
      <ServerSettingsModal open={open()} onOpenChange={setOpen} />
    </main>
  );
}

const meta = {
  title: "Settings/ServerSettingsModal",
  component: ServerSettingsModal,
  args: { open: false, onOpenChange: () => undefined },
  parameters: {
    layout: "fullscreen",
    a11y: { test: "error" },
    viewport: {
      options: {
        serverDesktop: {
          name: "Server settings — 1200 × 820",
          styles: { width: "1200px", height: "820px" },
        },
        serverMinimum: {
          name: "Server settings — 960 × 640",
          styles: { width: "960px", height: "640px" },
        },
      },
    },
  },
} satisfies Meta<typeof ServerSettingsModal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {
  render: () => <ServerSettingsModalStory initialOpen />,
};

export const Private: Story = {
  render: () => <ServerSettingsModalStory initialOpen />,
  play: async () => {
    const body = within(document.body);
    const publishSwitch = await body.findByRole("switch", { name: "Publish this server" });
    await fireEvent.click(publishSwitch);
    await expect(publishSwitch).not.toBeChecked();
    await waitFor(() =>
      expect(body.getByText("Not reachable online. Existing members and invitations remain.")).toBeVisible(),
    );
  },
};

export const Interactive: Story = {
  render: () => <ServerSettingsModalStory initialOpen={false} />,
  play: async ({ canvas, userEvent }) => {
    const body = within(document.body);
    const trigger = canvas.getByRole("button", { name: "Open server settings" });

    await userEvent.click(trigger);
    let dialog = await body.findByRole("dialog", { name: "General" });
    await waitFor(() => expect(dialog).toBeVisible());
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement)) throw new Error("The dialog did not receive focus.");
    await expect(dialog).toContainElement(activeElement);
    await expect(within(dialog).queryByRole("button", { name: "Remote desktop" })).not.toBeInTheDocument();

    const identitySection = body.getByRole("region", { name: "Identity" });
    const accessSection = body.getByRole("region", { name: "Access" });
    await expect(identitySection.querySelectorAll(".server-settings-general-row")).toHaveLength(2);
    await expect(accessSection.querySelectorAll(".server-settings-general-row")).toHaveLength(2);

    const serverName = body.getByRole("textbox", { name: "Server name" });
    await expect(body.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
    await userEvent.clear(serverName);
    await userEvent.type(serverName, "OpenBot studio");
    const saveBar = body.getByRole("region", { name: "Unsaved identity changes" });
    await expect(saveBar).toBeVisible();
    await expect(getComputedStyle(saveBar).position).toBe("absolute");
    await userEvent.click(within(saveBar).getByRole("button", { name: "Reset" }));
    await expect(body.queryByRole("region", { name: "Unsaved identity changes" })).not.toBeInTheDocument();
    await userEvent.clear(serverName);
    await userEvent.type(serverName, "Ops");
    await expect(body.getByText("Enter at least 6 characters.")).toBeVisible();
    await expect(body.getByRole("button", { name: "Save changes" })).toBeDisabled();
    await userEvent.clear(serverName);
    await userEvent.type(serverName, "OpenBot team");
    await expect(body.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
    await userEvent.clear(serverName);
    await userEvent.type(serverName, "Ops team");
    await userEvent.click(body.getByRole("button", { name: "Save changes" }));
    await expect(body.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();

    const logoFile = new File([new Uint8Array([137, 80, 78, 71])], "server-logo.png", { type: "image/png" });
    const replacementLogoFile = new File([new Uint8Array([82, 73, 70, 70])], "replacement-logo.webp", {
      type: "image/webp",
    });
    const logoInput = body.getByLabelText("Server logo");
    await expect(body.getByRole("button", { name: "Change server logo" })).toBeVisible();
    await userEvent.upload(logoInput, logoFile);
    await expect(body.getByRole("button", { name: "Remove server logo" })).toBeVisible();
    await userEvent.click(body.getByRole("button", { name: "Save changes" }));
    await expect(body.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();

    await userEvent.upload(logoInput, replacementLogoFile);
    await waitFor(() => expect(body.getByRole("region", { name: "Unsaved identity changes" })).toBeVisible());
    await userEvent.click(body.getByRole("button", { name: "Reset" }));
    await expect(body.queryByRole("region", { name: "Unsaved identity changes" })).not.toBeInTheDocument();
    await expect(body.getByRole("button", { name: "Remove server logo" })).toBeVisible();

    await userEvent.upload(logoInput, replacementLogoFile);
    await userEvent.click(body.getByRole("button", { name: "Save changes" }));
    await userEvent.click(body.getByRole("button", { name: "Remove server logo" }));
    await userEvent.click(body.getByRole("button", { name: "Save changes" }));
    await expect(body.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
    await expect(body.queryByRole("button", { name: "Remove server logo" })).not.toBeInTheDocument();
    await expect(body.getByRole("button", { name: "Change server logo" })).toBeVisible();

    const publishSwitch = body.getByRole("switch", { name: "Publish this server" });
    await userEvent.click(publishSwitch);
    await expect(publishSwitch).not.toBeChecked();
    await expect(body.getByText("Not reachable online. Existing members and invitations remain.")).toBeVisible();
    await expect(body.getByText("Not available while private")).toBeVisible();
    await expect(body.getByRole("button", { name: "Copy address" })).toBeDisabled();
    await expect(body.queryByRole("button", { name: "Invitations" })).not.toBeInTheDocument();
    await userEvent.click(body.getByRole("button", { name: "Members" }));
    await expect(body.getByRole("heading", { name: "Members", level: 2 })).toBeVisible();
    await waitFor(() => expect(body.getByText("Invitations are paused")).toBeVisible());
    await expect(body.getByText("new-person@example.com")).toBeVisible();
    await expect(body.getByRole("button", { name: "Send invite" })).toBeDisabled();
    await expect(body.getByText(/4 members/)).toBeVisible();
    const serverMembersHeading = body.getByRole("heading", { name: "Server members" });
    const pendingInvitationsHeading = body.getByRole("heading", { name: "Pending invitations" });
    await expect(
      Boolean(
        serverMembersHeading.compareDocumentPosition(pendingInvitationsHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
    await expect(document.querySelector(".server-settings-member-table-heading")).not.toBeInTheDocument();
    await expect(document.querySelector(".server-settings-invite-table-heading")).not.toBeInTheDocument();

    const scrollElement = body.getByTestId("settings-modal-scroll-frame").querySelector(".settings-modal-content");
    if (!(scrollElement instanceof HTMLElement)) throw new Error("Settings scroll element was not found.");
    scrollElement.scrollTop = 100;
    await fireEvent.scroll(scrollElement);

    await userEvent.click(body.getByRole("button", { name: "General" }));
    await waitFor(() => expect(body.getByRole("region", { name: "Access" })).toBeVisible());
    await expect(scrollElement.scrollTop).toBe(0);
    await userEvent.click(body.getByRole("switch", { name: "Publish this server" }));
    await expect(body.getByRole("switch", { name: "Publish this server" })).toBeChecked();
    await expect(body.getByText("Reachable online. Only invited people can sign in.")).toBeVisible();
    const copyAddress = body.getByRole("button", { name: "Copy address" });
    await userEvent.click(copyAddress);
    await expect(copyAddress).toHaveTextContent("Copied");

    await userEvent.click(body.getByRole("button", { name: "Members" }));
    await expect(body.getByRole("tab", { name: "Email" })).toHaveAttribute("data-selected");
    const sendInvite = body.getByRole("button", { name: "Send invite" });
    const inviteEmail = body.getByRole("textbox", { name: "Email address" });
    await expect(sendInvite).toBeDisabled();
    await userEvent.type(inviteEmail, "invalid-email");
    await userEvent.tab();
    await expect(body.getByText("Enter a valid email address.")).toBeVisible();
    await userEvent.clear(inviteEmail);
    await userEvent.type(inviteEmail, "invitee@example.com");
    await expect(sendInvite).toBeEnabled();
    const invitationRole = body.getByRole("button", { name: /^Invitation role/ });
    await userEvent.click(invitationRole);
    await userEvent.keyboard("{ArrowDown}{Enter}");
    await expect(invitationRole).toHaveTextContent("Admin");
    await userEvent.click(sendInvite);
    await expect(body.getByText("Invitation sent")).toBeVisible();
    await expect(within(body.getByRole("status")).getByText("invitee@example.com")).toBeVisible();

    await userEvent.click(body.getByRole("tab", { name: "Invite link" }));
    await userEvent.click(body.getByRole("button", { name: "Create link" }));
    await expect(body.getByText("Invitation link ready")).toBeVisible();
    const copyLink = body.getByRole("button", { name: "Copy link" });
    await userEvent.click(copyLink);
    await waitFor(() => expect(copyLink).toHaveTextContent("Copied"));
    await userEvent.click(body.getAllByRole("button", { name: "Revoke" })[0]);

    const membersList = within(body.getByTestId("server-members-list"));
    const memberSearch = body.getByRole("searchbox", { name: "Search members" });
    await userEvent.type(memberSearch, "Jon");
    await expect(membersList.getByText("Jon Bell")).toBeVisible();
    await waitFor(() => expect(membersList.queryByText("Alice Chen")).not.toBeInTheDocument());
    await userEvent.clear(memberSearch);

    const ownerRow = membersList.getByText("Norbert").closest(".server-settings-member-row");
    if (!(ownerRow instanceof HTMLElement)) throw new Error("Owner row was not found.");
    await expect(within(ownerRow).getByText("Owner")).toBeVisible();
    await expect(within(ownerRow).queryByRole("button", { name: "Actions for Norbert" })).not.toBeInTheDocument();

    const jonRow = membersList.getByText("Jon Bell").closest(".server-settings-member-row");
    if (!(jonRow instanceof HTMLElement)) throw new Error("Jon row was not found.");
    await userEvent.click(within(jonRow).getByRole("button", { name: "Actions for Jon Bell" }));
    const memberMenu = await body.findByRole("menu");
    const makeAdminItem = within(memberMenu).getByRole("menuitem", { name: "Make admin" });
    await expect(memberMenu).toHaveClass("ui-action-menu");
    await expect(memberMenu.getBoundingClientRect().width).toBe(160);
    await expect(makeAdminItem.getBoundingClientRect().height).toBe(32);
    await expect(makeAdminItem.querySelector("svg")?.getBoundingClientRect().width).toBe(16);
    await expect(getComputedStyle(makeAdminItem).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    const removeItem = within(memberMenu).getByRole("menuitem", { name: "Remove member" });
    const removeIcon = removeItem.querySelector("svg");
    if (!(removeIcon instanceof SVGElement)) throw new Error("Remove member icon was not found.");
    await expect(getComputedStyle(removeItem).color).not.toBe(getComputedStyle(makeAdminItem).color);
    await expect(getComputedStyle(removeIcon).color).toBe(getComputedStyle(removeItem).color);
    await userEvent.click(makeAdminItem);
    await expect(within(jonRow).getByText("Admin")).toBeVisible();
    await waitFor(() => expect(body.queryByRole("menuitem", { name: "Make admin" })).not.toBeInTheDocument());
    const jonActions = within(jonRow).getByRole("button", { name: "Actions for Jon Bell" });
    await waitFor(() => expect(jonActions).toHaveAttribute("data-closed"));
    await new Promise((resolve) => window.setTimeout(resolve, 160));
    await userEvent.click(jonActions);
    await userEvent.click(await body.findByRole("menuitem", { name: "Pause access" }));
    await waitFor(() => expect(within(jonRow).getByText("Paused")).toBeVisible());
    await waitFor(() => expect(body.queryByRole("menuitem", { name: "Pause access" })).not.toBeInTheDocument());
    await waitFor(() => expect(jonActions).toHaveAttribute("data-closed"));
    await new Promise((resolve) => window.setTimeout(resolve, 160));
    await userEvent.click(jonActions);
    await userEvent.click(await body.findByRole("menuitem", { name: "Restore access" }));
    await waitFor(() => expect(within(jonRow).getByText("Offline")).toBeVisible());

    await waitFor(() => expect(body.queryByRole("menuitem", { name: "Restore access" })).not.toBeInTheDocument());
    await new Promise((resolve) => window.setTimeout(resolve, 160));
    await userEvent.click(body.getByRole("button", { name: "Actions for Maya Singh" }));
    await userEvent.click(await body.findByRole("menuitem", { name: "Remove member" }));
    const confirmation = body.getByRole("alert");
    await expect(confirmation).toBeVisible();
    await userEvent.click(within(confirmation).getByRole("button", { name: "Remove member" }));
    await waitFor(() => expect(membersList.queryByText("Maya Singh")).not.toBeInTheDocument());
    await expect(body.queryByRole("heading", { name: "Active sessions" })).not.toBeInTheDocument();

    await userEvent.click(body.getByRole("button", { name: "Close server settings" }));
    await expect(dialog).toHaveAttribute("data-motion", "closing");
    await waitFor(() => expect(body.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());

    await userEvent.click(trigger);
    dialog = await body.findByRole("dialog", { name: "Members" });
    await userEvent.keyboard("{Escape}");
    await expect(dialog).toHaveAttribute("data-motion", "closing");
    await waitFor(() => expect(body.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());

    await userEvent.click(trigger);
    await body.findByRole("dialog", { name: "Members" });
    await userEvent.click(body.getByTestId("settings-modal-backdrop"));
    await waitFor(() => expect(body.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  },
};
