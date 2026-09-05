import { createSignal, onSettled, Show } from "solid-js";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { type MessageTextSelection, SelectionActionsBar } from "../src/features/conversation/SelectionActions";

function SelectionActionsDemo(props: {
  onSend?: (messageId: string, body: string) => Promise<boolean>;
  width?: string;
}) {
  const [selection, setSelection] = createSignal<MessageTextSelection | null>(null);
  let text: HTMLSpanElement | undefined;

  onSettled(() => {
    if (!text) return;
    const range = document.createRange();
    range.selectNodeContents(text);
    setSelection({
      messageId: "selection-actions-story",
      text: text.textContent ?? "",
      range,
    });
  });

  return (
    <div
      style={{
        width: props.width ?? "560px",
        "max-width": "calc(100vw - 48px)",
        padding: "96px 36px 120px",
        background: "var(--openbot-bg-canvas)",
        color: "var(--openbot-text-primary)",
      }}
    >
      <p style={{ margin: "0", "font-size": "14px", "line-height": "21px" }}>
        The launch note is almost ready.{" "}
        <span ref={(element) => (text = element)}>Make the closing sentence warmer and more concise.</span>
      </p>
      <Show when={selection()}>
        {(active) => (
          <SelectionActionsBar
            selection={active()}
            fallbackHighlight
            onDismiss={fn()}
            onSend={props.onSend ?? fn().mockResolvedValue(true)}
          />
        )}
      </Show>
    </div>
  );
}

const meta = {
  title: "Conversation/SelectionActions",
  component: SelectionActionsDemo,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof SelectionActionsDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const CustomInstruction: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await selectionActionsReady(page);
    const toolbar = page.getByRole("toolbar", { name: "Actions for selected text" });
    const input = await page.findByRole("textbox", { name: "Describe edits" });
    const initialWidth = toolbar.getBoundingClientRect().width;
    await userEvent.type(input, "M");
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(Math.abs(toolbar.getBoundingClientRect().width - initialWidth)).toBeLessThan(1);
    await userEvent.type(input, "ake this friendlier");
    await expect(page.getByRole("button", { name: "Send edit instruction" })).toBeVisible();
  },
};

export const Expanded: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await selectionActionsReady(page);
    await userEvent.click(await page.findByRole("button", { name: "Show more actions" }));
    await waitFor(() => expect(page.getByRole("button", { name: "Grammar" })).toBeVisible());
  },
};

export const Sending: Story = {
  args: {
    onSend: () => new Promise<boolean>(() => undefined),
  },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await selectionActionsReady(page);
    await userEvent.click(await page.findByRole("button", { name: "Improve" }));
    await expect(page.getByRole("status")).toHaveTextContent("Sending…");
  },
};

export const SendError: Story = {
  args: {
    onSend: fn().mockResolvedValue(false),
  },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await selectionActionsReady(page);
    await userEvent.click(await page.findByRole("button", { name: "Improve" }));
    await expect(page.findByRole("alert")).resolves.toHaveTextContent("Couldn’t send");
  },
};

export const Narrow: Story = {
  args: { width: "280px" },
  parameters: {
    viewport: { defaultViewport: "mobile2" },
  },
};

async function selectionActionsReady(page: ReturnType<typeof within>): Promise<void> {
  const toolbar = await page.findByRole("toolbar", { name: "Actions for selected text" });
  const layer = toolbar.closest(".selection-actions-layer");
  if (!layer) throw new Error("Selection actions layer is missing");
  await waitFor(() => expect(layer).toHaveAttribute("data-ready", "true"));
}
