import { createSignal, onCleanup, type ParentProps } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Button, Heading, Text, Toaster, toast } from "../src/components/ui";

const meta = {
  title: "Foundations/Toast",
  component: Toaster,
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta<typeof Toaster>;
export default meta;
type Story = StoryObj<typeof meta>;

function ToastStory(props: ParentProps): ReturnType<typeof Toaster> {
  onCleanup(() => toast.dismiss());
  return (
    <main class="foundation-story">
      {props.children}
      <Toaster />
    </main>
  );
}

export const Gallery: Story = {
  render: () => (
    <ToastStory>
      <Heading as="h1" size="lg">
        Toasts
      </Heading>
      <Text tone="secondary">Trigger each tone or create a compact stack.</Text>
      <div class="foundation-story-row">
        <Button
          variant="outline"
          onClick={() =>
            toast("Agent updated", {
              description: "The new settings are already active.",
            })
          }
        >
          Default
        </Button>
        <Button variant="outline" onClick={() => toast.success("Changes saved successfully.")}>
          Success
        </Button>
        <Button variant="outline" onClick={() => toast.info("A newer model is available.")}>
          Info
        </Button>
        <Button variant="outline" onClick={() => toast.warning("This action will interrupt the active turn.")}>
          Warning
        </Button>
        <Button variant="outline" onClick={() => toast.error("The server could not be reached.")}>
          Error
        </Button>
        <Button variant="outline" onClick={() => toast.loading("Connecting to the server…")}>
          Loading
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            toast.info("Reading workspace state…");
            toast.success("Agent is ready.");
            toast("Background sync completed.");
          }}
        >
          Show stack
        </Button>
      </div>
    </ToastStory>
  ),
};

export const WithAction: Story = {
  render: () => {
    const [status, setStatus] = createSignal("No action yet.");
    return (
      <ToastStory>
        <Heading as="h1" size="lg">
          Toast action
        </Heading>
        <Text tone="secondary">{status()}</Text>
        <div class="foundation-story-row">
          <Button
            variant="outline"
            onClick={() => {
              setStatus("Message archived.");
              toast("Message archived", {
                description: "You can restore it while this notification is visible.",
                action: {
                  label: "Undo",
                  onClick: () => setStatus("Message restored."),
                },
              });
            }}
          >
            Archive message
          </Button>
        </div>
      </ToastStory>
    );
  },
};

export const PromiseFlow: Story = {
  render: () => {
    function showPromise(shouldReject: boolean): void {
      const request = new Promise<string>((resolve, reject) => {
        window.setTimeout(() => {
          if (shouldReject) reject(new Error("Connection timed out"));
          else resolve("Workspace synchronized.");
        }, 1_200);
      });

      toast.promise(request, {
        loading: "Synchronizing workspace…",
        success: (message: string) => message,
        error: (error: unknown) => (error instanceof Error ? error.message : "Synchronization failed."),
      });
    }

    return (
      <ToastStory>
        <Heading as="h1" size="lg">
          Promise toast
        </Heading>
        <Text tone="secondary">The loading notification updates in place when the request settles.</Text>
        <div class="foundation-story-row">
          <Button variant="outline" onClick={() => showPromise(false)}>
            Resolve promise
          </Button>
          <Button variant="outline" onClick={() => showPromise(true)}>
            Reject promise
          </Button>
        </div>
      </ToastStory>
    );
  },
};
