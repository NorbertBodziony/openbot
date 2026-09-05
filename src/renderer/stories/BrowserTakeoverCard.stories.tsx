import type { BrowserPreview, BrowserTab } from "@openbot/contracts/ipc";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { BrowserTakeoverCard } from "../src/features/conversation/ConversationPrompts";
import browserTakeoverPreviewUrl from "./assets/browser-takeover-preview.svg";

const tab: BrowserTab = {
  id: "tab-login",
  title: "Sign in",
  url: "https://accounts.example.com/login",
  loading: false,
  ownerThreadId: "thread-chief",
  ownerAgentId: "chief",
};

const preview: BrowserPreview = {
  dataUrl: browserTakeoverPreviewUrl,
  width: 960,
  height: 600,
};

const meta = {
  title: "Conversation/BrowserTakeoverCard",
  component: BrowserTakeoverCard,
  args: {
    agentName: "Chief",
    tab,
    preview,
    previewStatus: "ready",
    onComplete: fn(async () => true),
    onCancel: fn(async () => true),
  },
  parameters: { layout: "centered", a11y: { test: "error" } },
} satisfies Meta<typeof BrowserTakeoverCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {};

export const Loading: Story = {
  args: { preview: null, previewStatus: "loading" },
};

export const PreviewUnavailable: Story = {
  args: { preview: null, previewStatus: "failed" },
};

export const Narrow: Story = {
  render: (args) => (
    <div style={{ width: "340px" }}>
      <BrowserTakeoverCard {...args} />
    </div>
  ),
};

export const Completed: Story = {
  args: { decision: "complete" },
};

export const Cancelled: Story = {
  args: { decision: "cancel" },
};
