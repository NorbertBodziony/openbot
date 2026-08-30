import type { AttachmentSummary, ImageGenerationAspectRatio } from "@openbot/contracts/ipc";
import { createEffect, createSignal, Show } from "solid-js";
import { Button } from "../ui";
import { DownloadIcon } from "./ConversationIcons";

export type ImageGenerationStatus = "generating" | "completed" | "failed" | "interrupted";

export interface ImageGenerationProps {
  status: ImageGenerationStatus;
  presentation?: "generated" | "attachment";
  prompt?: string;
  resolution?: string;
  aspectRatio: ImageGenerationAspectRatio;
  attachment?: AttachmentSummary;
  error?: string;
  onPreview?: (attachment: AttachmentSummary) => void;
  onDownload?: (attachment: AttachmentSummary) => void;
}

export function ImageGeneration(props: ImageGenerationProps) {
  const [previewError, setPreviewError] = createSignal(false);
  const [imageRatio, setImageRatio] = createSignal<string | null>(null);
  createEffect(
    () => `${props.attachment?.id ?? ""}:${props.attachment?.previewUrl ?? ""}`,
    () => {
      setPreviewError(false);
      setImageRatio(null);
    },
  );

  const previewUnavailable = () => props.status === "completed" && !props.attachment?.previewUrl;
  const isAttachment = () => props.presentation === "attachment";
  const hasImage = () => props.status === "completed" && Boolean(props.attachment?.previewUrl) && !previewError();
  const hasFailure = () =>
    props.status === "failed" || props.status === "interrupted" || previewError() || previewUnavailable();
  const failure = () =>
    previewError() || previewUnavailable()
      ? isAttachment()
        ? "The image preview is unavailable."
        : "The generated image preview is unavailable."
      : (props.error ??
        (props.status === "interrupted" ? "Image generation was interrupted." : "Image generation did not complete."));
  const label = () => {
    if (props.status === "generating") return "Generating image";
    if (previewError() || previewUnavailable()) return "Image unavailable";
    if (props.status === "interrupted") return "Image generation interrupted";
    if (props.status === "failed") return "Image generation failed";
    return isAttachment() ? "Attached image" : "Generated image";
  };
  const previewLabel = () =>
    isAttachment() ? `Preview ${props.attachment?.name ?? "attached image"}` : "Preview generated image";
  const downloadLabel = () =>
    isAttachment() ? `Download ${props.attachment?.name ?? "attached image"}` : "Download generated image";
  const stageRatio = () => (hasImage() && imageRatio() ? imageRatio() : ratioValue(props.aspectRatio));

  return (
    <section
      class={[
        "image-generation",
        {
          "image-generation-ready": hasImage(),
          "image-generation-failed": hasFailure(),
        },
      ]}
      aria-label={hasImage() ? label() : isAttachment() ? "Image attachment" : "Image generation"}
      aria-live={props.status === "generating" ? "polite" : undefined}
    >
      <div class="image-generation-stage" style={`--image-generation-ratio: ${stageRatio()}`}>
        <div
          class={[
            "image-generation-canvas",
            {
              "image-generation-canvas-visible": !hasImage(),
              "image-generation-canvas-failed": hasFailure(),
            },
          ]}
          role="img"
          aria-label={hasImage() ? undefined : label()}
          aria-hidden={hasImage() ? "true" : undefined}
          aria-busy={props.status === "generating" ? "true" : undefined}
        >
          <Show
            when={!hasFailure()}
            fallback={
              <span class="image-generation-failure-mark" aria-hidden="true">
                ×
              </span>
            }
          >
            <div class="image-generation-dots" aria-hidden="true" />
            <div class="image-generation-glow" aria-hidden="true" />
          </Show>
          <Show when={props.resolution}>
            <span class="image-generation-resolution">{props.resolution}</span>
          </Show>
        </div>
        <Show when={Boolean(props.attachment?.previewUrl) && !previewError()}>
          <Button
            variant="ghost"
            type="button"
            class={["image-generation-preview", { "image-generation-preview-visible": hasImage() }]}
            aria-label={previewLabel()}
            onClick={() => {
              if (props.attachment) props.onPreview?.(props.attachment);
            }}
          >
            <img
              src={props.attachment?.previewUrl ?? ""}
              alt={props.prompt ?? "Generated image"}
              onLoad={(event) => {
                const { naturalHeight, naturalWidth } = event.currentTarget;
                if (naturalWidth > 0 && naturalHeight > 0) setImageRatio(`${naturalWidth} / ${naturalHeight}`);
              }}
              onError={() => setPreviewError(true)}
            />
          </Button>
        </Show>
        <Show when={hasImage() && props.attachment && props.onDownload}>
          <Button
            variant="ghost"
            type="button"
            class="image-generation-hover-download"
            aria-label={downloadLabel()}
            title={downloadLabel()}
            onClick={(event) => {
              event.stopPropagation();
              if (props.attachment) props.onDownload?.(props.attachment);
            }}
          >
            <DownloadIcon />
            Download
          </Button>
        </Show>
      </div>
      <Show when={!hasImage()}>
        <div class="image-generation-meta">
          <span class="image-generation-label">{label()}</span>
          <Show when={props.prompt}>
            <span class="image-generation-prompt">“{props.prompt}”</span>
          </Show>
          <Show when={hasFailure()}>
            <span class="image-generation-error" role="alert">
              {failure()}
            </span>
          </Show>
        </div>
      </Show>
    </section>
  );
}

function ratioValue(aspectRatio: ImageGenerationAspectRatio): "4 / 5" | "4 / 3" | "1 / 1" {
  if (aspectRatio === "portrait") return "4 / 5";
  if (aspectRatio === "landscape") return "4 / 3";
  return "1 / 1";
}
