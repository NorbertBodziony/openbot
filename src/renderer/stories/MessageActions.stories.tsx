import { expect, fn, waitFor, within } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import type { AgentMessage } from "../src/data";
import { MessageActions } from "../src/features/conversation/MessageRendering";

const message: AgentMessage = {
  id: "message-actions-1",
  author: "agent",
  body: "A message with available actions.",
  time: "10:00",
};

const args: Parameters<typeof MessageActions>[0] = {
  message,
  pickerOpen: false,
  moreOpen: false,
  expandedEmoji: false,
  copied: false,
  onTogglePicker: fn(),
  onToggleMore: fn(),
  onExpandEmoji: fn(),
  onReact: fn(),
  onReply: fn(),
  onCopy: fn(),
};

const meta = {
  title: "Conversation/MessageActions",
  component: MessageActions,
  args,
  parameters: { layout: "centered", a11y: { test: "error" } },
} satisfies Meta<typeof MessageActions>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const ReactionPicker: Story = {
  args: { pickerOpen: true },
  play: async ({ canvasElement }) => {
    const menu = await waitFor(() => {
      const element = canvasElement.ownerDocument.querySelector<HTMLElement>(".reaction-picker");
      if (!element) throw new Error("Reaction picker was not mounted.");
      return element;
    });
    await expect(menu).toHaveClass("ui-action-menu");
    await expect(menu).toHaveAttribute("role", "menu");
    await expect(menu).toHaveAttribute("aria-label", "Choose a reaction");
    await expect(menu).toHaveAttribute("data-menu-layout", "grid");
    await expect(getComputedStyle(menu).padding).toBe("4px");
    await expect(getComputedStyle(menu).borderRadius).toBe("8px");
  },
};

export const MoreMenu: Story = {
  args: { moreOpen: true },
  play: async ({ canvasElement }) => {
    const menu = await within(canvasElement.ownerDocument.body).findByRole("menu");
    const item = within(menu).getByRole("menuitem", { name: "Copy" });
    await expect(menu).toHaveClass("ui-action-menu");
    await expect(menu.getBoundingClientRect().width).toBe(160);
    await expect(item.getBoundingClientRect().height).toBe(32);
    await expect(item.querySelector("svg")?.getBoundingClientRect().width).toBe(16);
  },
};
