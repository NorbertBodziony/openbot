import type { AttachmentSummary } from "@openbot/contracts/ipc";
import { For, Show } from "solid-js";
import { Button } from "../ui";

export function AttachmentCards(props: {
  attachments: AttachmentSummary[];
  onPreview: (attachment: AttachmentSummary) => void;
  onAction: (attachment: AttachmentSummary, action: "open" | "reveal") => void;
}) {
  return (
    <div class="message-attachments">
      <For each={props.attachments}>
        {(attachment) => (
          <div class="message-attachment">
            <Button
              type="button"
              class="attachment-preview-button"
              disabled={attachment.previewKind === "none"}
              aria-label={`Preview ${attachment.name}`}
              onClick={() => props.onPreview(attachment)}
            >
              <Show
                when={attachment.previewKind === "image"}
                fallback={
                  <span class="attachment-file-visual" aria-hidden="true">
                    <AttachmentFileIcon />
                  </span>
                }
              >
                <span class="attachment-file-visual attachment-file-image">
                  <img src={attachment.previewUrl ?? ""} alt="" />
                </span>
              </Show>
              <span class="attachment-file-copy">
                <strong>{attachment.name}</strong>
                <small>{formatFileSize(attachment.size)}</small>
              </span>
            </Button>
            <Button
              type="button"
              class="attachment-open-button"
              aria-label={`Open ${attachment.name}`}
              title="Open file"
              onClick={() => props.onAction(attachment, "open")}
            >
              <AttachmentOpenIcon />
            </Button>
          </div>
        )}
      </For>
    </div>
  );
}

export function fileBadge(attachment: AttachmentSummary): string {
  if (attachment.previewKind === "pdf") return "PDF";
  if (attachment.previewKind === "text") return "TXT";
  return attachment.name.split(".").at(-1)?.slice(0, 4).toUpperCase() || "FILE";
}

function AttachmentFileIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="M5.5 2.75h5.75l3.25 3.5v11H5.5z" />
      <path d="M11.25 2.75v3.5h3.25M7.75 10h4.5M7.75 13h4.5" />
    </svg>
  );
}

function AttachmentOpenIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="M6.1 14.75H5.5a3.25 3.25 0 0 1-.2-6.5A4.85 4.85 0 0 1 14.55 7a3.65 3.65 0 0 1-.05 7.3h-.6" />
      <path d="M10 8.75v7.5m-2.6-2.6L10 16.25l2.6-2.6" />
    </svg>
  );
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
