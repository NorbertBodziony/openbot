import type { AttachmentSummary, ImageGenerationAspectRatio } from "@openbot/contracts/ipc";
import { createEffect, createSignal, Show } from "solid-js";

export type ImageGenerationStatus = "generating" | "completed" | "failed" | "interrupted";

export interface ImageGenerationProps {
  status: ImageGenerationStatus;
  prompt?: string;
  resolution: string;
  aspectRatio: ImageGenerationAspectRatio;
  attachment?: AttachmentSummary;
  error?: string;
  onPreview?: (attachment: AttachmentSummary) => void;
  onDownload?: (attachment: AttachmentSummary) => void;
  onRetry?: () => void;
}

export function ImageGeneration(props: ImageGenerationProps) {
  const [previewError, setPreviewError] = createSignal(false);
  createEffect(
    () => props.attachment?.id,
    () => {
      setPreviewError(false);
    },
  );

  const previewUnavailable = () => props.status === "completed" && !props.attachment?.previewUrl;
  const hasImage = () => props.status === "completed" && Boolean(props.attachment?.previewUrl) && !previewError();
  const hasFailure = () =>
    props.status === "failed" || props.status === "interrupted" || previewError() || previewUnavailable();
  const failure = () =>
    previewError() || previewUnavailable()
      ? "The generated image preview is unavailable."
      : (props.error ??
        (props.status === "interrupted" ? "Image generation was interrupted." : "Image generation did not complete."));

  return (
    <section
      class={[
        "image-generation",
        {
          "image-generation-ready": hasImage(),
          "image-generation-failed": hasFailure(),
        },
      ]}
      aria-label={hasImage() ? "Generated image" : "Image generation"}
    >
      <div class="image-generation-stage" style={`--image-generation-ratio: ${ratioValue(props.aspectRatio)}`}>
        <div
          class={["image-generation-canvas", { "image-generation-canvas-visible": !hasImage() }]}
          role={props.status === "generating" ? "status" : undefined}
          aria-live={props.status === "generating" ? "polite" : undefined}
          aria-busy={props.status === "generating" ? "true" : undefined}
        >
          <div class="image-generation-dots" aria-hidden="true" />
          <div class="image-generation-glow" aria-hidden="true" />
          <div class="image-generation-canvas-content">
            <div class="image-generation-topline">
              <span class="image-generation-spark" aria-hidden="true">
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M8 1.5 9.4 6.6 14.5 8l-5.1 1.4L8 14.5l-1.4-5.1L1.5 8l5.1-1.4L8 1.5Z" />
                </svg>
              </span>
              <span>
                {props.status === "generating"
                  ? "Generating image"
                  : hasFailure()
                    ? "Image unavailable"
                    : "Image generation"}
              </span>
              <span class="image-generation-resolution">{props.resolution}</span>
            </div>
            <Show when={props.prompt}>
              <p class="image-generation-prompt">“{props.prompt}”</p>
            </Show>
            <Show when={hasFailure()}>
              <p class="image-generation-error" role="alert">
                {failure()}
              </p>
            </Show>
          </div>
        </div>
        <Show when={Boolean(props.attachment?.previewUrl) && !previewError()}>
          <button
            type="button"
            class={["image-generation-preview", { "image-generation-preview-visible": hasImage() }]}
            aria-label="Preview generated image"
            onClick={() => {
              if (props.attachment) props.onPreview?.(props.attachment);
            }}
          >
            <img
              src={props.attachment?.previewUrl ?? ""}
              alt={props.prompt ?? "Generated image"}
              onError={() => setPreviewError(true)}
            />
          </button>
        </Show>
      </div>
      <Show when={hasImage() && props.attachment && props.onDownload}>
        <div class="image-generation-actions">
          <button
            type="button"
            class="image-generation-download"
            onClick={() => {
              if (props.attachment) props.onDownload?.(props.attachment);
            }}
          >
            Download
          </button>
        </div>
      </Show>
      <Show when={hasFailure() && props.onRetry}>
        <button type="button" class="image-generation-retry" onClick={props.onRetry}>
          Try again
        </button>
      </Show>
    </section>
  );
}

function ratioValue(aspectRatio: ImageGenerationAspectRatio): "4 / 5" | "4 / 3" | "1 / 1" {
  if (aspectRatio === "portrait") return "4 / 5";
  if (aspectRatio === "landscape") return "4 / 3";
  return "1 / 1";
}
