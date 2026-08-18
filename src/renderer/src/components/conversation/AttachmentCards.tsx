import type { AttachmentSummary } from "@openbot/contracts/ipc";
import { For, Show } from "solid-js";

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
            <button
              type="button"
              class="attachment-preview-button"
              disabled={attachment.previewKind === "none"}
              aria-label={`Preview ${attachment.name}`}
              onClick={() => props.onPreview(attachment)}
            >
              <Show
                when={attachment.previewKind === "image"}
                fallback={<span class="file-type-badge">{fileBadge(attachment)}</span>}
              >
                <img src={attachment.previewUrl ?? ""} alt="" />
              </Show>
              <span>
                <strong>{attachment.name}</strong>
                <small>{formatFileSize(attachment.size)}</small>
              </span>
            </button>
            <div class="attachment-actions">
              <button type="button" onClick={() => props.onAction(attachment, "open")}>
                Open
              </button>
              <button type="button" onClick={() => props.onAction(attachment, "reveal")}>
                Finder
              </button>
            </div>
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

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
