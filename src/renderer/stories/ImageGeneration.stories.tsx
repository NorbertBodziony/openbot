import type { AttachmentSummary } from "@openbot/contracts/ipc";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { ImageGeneration, type ImageGenerationProps } from "../src/components/conversation/ImageGeneration";

const generatedPreview = new URL("../src/assets/openbot-logo-production.png", import.meta.url).href;

const generatedAttachment: AttachmentSummary = {
  id: "generated-image-1",
  name: "generated-image.png",
  size: 184_320,
  kind: "image",
  mimeType: "image/png",
  previewKind: "image",
  previewUrl: generatedPreview,
};

const baseArgs: ImageGenerationProps = {
  status: "generating",
  prompt: "A quiet observatory above the clouds at blue hour",
  resolution: "1024 × 1024",
  aspectRatio: "square",
  onPreview: fn(),
  onDownload: fn(),
};

const meta = {
  title: "Conversation/ImageGeneration",
  component: ImageGeneration,
  args: baseArgs,
  parameters: { layout: "centered" },
  render: (storyArgs) => (
    <div style={{ width: "min(440px, 92vw)" }}>
      <ImageGeneration {...storyArgs} />
    </div>
  ),
} satisfies Meta<typeof ImageGeneration>;

export default meta;
type Story = StoryObj<typeof meta>;

export const GeneratingSquare: Story = {};

export const GeneratingPortrait: Story = {
  args: { aspectRatio: "portrait", resolution: "1024 × 1280" },
};

export const GeneratingLandscape: Story = {
  args: { aspectRatio: "landscape", resolution: "1536 × 1024" },
};

export const Completed: Story = {
  args: { status: "completed", attachment: generatedAttachment },
};

export const Failed: Story = {
  args: {
    status: "failed",
    error: "The image provider could not finish this request.",
  },
};

export const Interrupted: Story = {
  args: { status: "interrupted", error: "Generation stopped before the image was ready." },
};

export const LongPrompt: Story = {
  args: {
    prompt:
      "A cinematic editorial still of a glass observatory floating above a sleeping alpine valley, subtle aurora reflections, paper grain, restrained color, soft atmospheric perspective, architectural photography, no text",
  },
};
