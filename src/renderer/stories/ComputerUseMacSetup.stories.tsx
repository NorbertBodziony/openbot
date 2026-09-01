import type { ComputerUseMacSetupState } from "@openbot/contracts/ipc";
import { onCleanup } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { ComputerUseSetupSurface } from "../src/ComputerUseSetupSurface";
import { ComputerUseMacSetup } from "../src/components/ComputerUseMacSetup";
import { Toaster, toast } from "../src/components/ui";
import { createMockOpenBot } from "./mock-openbot";

const availableState: ComputerUseMacSetupState = {
  status: "available",
  helperName: "Codex Computer Use",
  helperIconDataUrl: null,
  message: null,
};

function MockedSetup(props: { state?: ComputerUseMacSetupState; error?: Error; loading?: boolean }) {
  const previousApi = window.openbot;
  const mock = createMockOpenBot();
  mock.api.getComputerUseMacSetupState = props.loading
    ? () => new Promise(() => undefined)
    : props.error
      ? async () => {
          throw props.error;
        }
      : async () => props.state ?? availableState;
  window.openbot = mock.api;
  onCleanup(() => {
    mock.dispose();
    toast.dismiss();
    window.openbot = previousApi;
  });
  return (
    <main class="foundation-story foundation-interaction-stage">
      <ComputerUseMacSetup platform="darwin" variant="compact" />
      <Toaster />
    </main>
  );
}

const meta = {
  title: "Settings/ComputerUseMacSetup",
  component: ComputerUseMacSetup,
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta<typeof ComputerUseMacSetup>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Available: Story = {
  render: () => <MockedSetup />,
};

export const Loading: Story = {
  render: () => <MockedSetup loading />,
};

export const HelperMissing: Story = {
  render: () => (
    <MockedSetup
      state={{
        status: "unavailable",
        helperName: "Codex Computer Use",
        helperIconDataUrl: null,
        message: "Codex Computer Use is not installed. Install or enable the Computer Use plugin, then try again.",
      }}
    />
  ),
};

export const Failure: Story = {
  render: () => <MockedSetup error={new Error("OpenBot could not check Computer Use.")} />,
};

export const DragHelper: Story = {
  render: () => {
    const previousApi = window.openbot;
    const mock = createMockOpenBot();
    window.openbot = mock.api;
    onCleanup(() => {
      mock.dispose();
      window.openbot = previousApi;
    });
    return (
      <div style={{ width: "360px", height: "300px" }}>
        <ComputerUseSetupSurface />
      </div>
    );
  },
  parameters: { layout: "centered" },
};
