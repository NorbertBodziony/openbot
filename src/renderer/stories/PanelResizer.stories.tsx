import { createSignal } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { PanelResizer } from "../src/components/PanelResizer";

const meta = {
  title: "Layout/PanelResizer",
  component: PanelResizer,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof PanelResizer>;

export default meta;
type Story = StoryObj<typeof meta>;

const baseArgs: Parameters<typeof PanelResizer>[0] = {
  label: "Resize sidebar",
  controls: "resizable-sidebar",
  direction: "left",
  value: 280,
  defaultValue: 280,
  min: 240,
  max: 400,
  onResize: () => undefined,
  onResizeEnd: () => undefined,
};

export const Resizable: Story = {
  args: baseArgs,
  render: () => {
    const [width, setWidth] = createSignal(280);
    return (
      <div class="flex h-screen">
        <aside style={{ width: `${width()}px` }} class="sidebar" aria-label="Resizable sidebar" />
        <PanelResizer
          label="Resize sidebar"
          controls="resizable-sidebar"
          direction="left"
          value={width()}
          defaultValue={280}
          min={240}
          max={400}
          onResize={setWidth}
          onResizeEnd={setWidth}
        />
        <main class="min-w-0 flex-1" />
      </div>
    );
  },
};

export const CompactSnap: Story = {
  args: baseArgs,
  render: () => {
    const [width, setWidth] = createSignal(280);
    const [compact, setCompact] = createSignal(false);
    return (
      <div class="flex h-screen">
        <aside
          style={{ width: `${compact() ? 88 : width()}px` }}
          class="sidebar"
          aria-label="Snapping sidebar"
        />
        <PanelResizer
          label="Resize snapping sidebar"
          controls="snapping-sidebar"
          direction="left"
          value={width()}
          defaultValue={280}
          min={240}
          max={400}
          onResize={setWidth}
          onResizeEnd={setWidth}
          snap={{
            compactValue: 88,
            compact: compact(),
            collapseThreshold: 210,
            expandThreshold: 220,
            onCompactChange: setCompact,
          }}
        />
        <main class="min-w-0 flex-1" />
      </div>
    );
  },
};
