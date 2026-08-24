import type { FilePreview } from "@openbot/contracts/ipc";
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import type { BotProfile } from "../../data";
import { PanelResizer, readPanelWidth, savePanelWidth } from "../PanelResizer";
import { Button, ExternalLink, File, X } from "../ui";
import { MarkdownMessageText } from "./MarkdownMessageText";

const PANEL_STORAGE_KEY = "openbot:browser-panel-width";
const PANEL_MIN = 220;
const PANEL_MAX = 1600;
const TEXT_LIMIT = 1_000_000;

interface FilePreviewPanelProps {
  preview: FilePreview;
  bots: BotProfile[];
  defaultWidth: () => number;
  maxWidth: () => number;
  onWidthChange: (width: number) => void;
  onOpenLink: (url: string) => void;
  onOpenSharedFile: (path: string) => void;
  onOpenWorkspaceFile: (path: string) => void;
  onOpenExternally: () => void;
  onClose: () => void;
}

export default function FilePreviewPanel(props: FilePreviewPanelProps) {
  const defaultPanelWidth = () => Math.round(Math.min(PANEL_MAX, Math.max(PANEL_MIN, props.defaultWidth())));
  const [panelWidth, setPanelWidth] = createSignal(
    readPanelWidth(PANEL_STORAGE_KEY, defaultPanelWidth(), PANEL_MIN, PANEL_MAX),
  );
  const [previewUrl, setPreviewUrl] = createSignal<string | null>(null);
  let currentPreviewUrl: string | null = null;
  const text = createMemo(() => {
    if (!props.preview.bytes || (props.preview.previewKind !== "text" && props.preview.previewKind !== "markdown")) {
      return { value: "", truncated: false };
    }
    const value = new TextDecoder().decode(props.preview.bytes);
    return { value: value.slice(0, TEXT_LIMIT), truncated: value.length > TEXT_LIMIT };
  });

  createEffect(
    () => panelWidth(),
    (width) => {
      props.onWidthChange(width);
    },
  );
  createEffect(
    () => props.preview,
    (preview) => {
      if (currentPreviewUrl) URL.revokeObjectURL(currentPreviewUrl);
      currentPreviewUrl = null;
      if (!preview.bytes || (preview.previewKind !== "image" && preview.previewKind !== "pdf")) {
        setPreviewUrl(null);
        return;
      }
      const url = URL.createObjectURL(new Blob([new Uint8Array(preview.bytes).buffer], { type: preview.mimeType }));
      currentPreviewUrl = url;
      setPreviewUrl(url);
    },
  );
  onCleanup(() => {
    if (currentPreviewUrl) URL.revokeObjectURL(currentPreviewUrl);
  });

  const resizeDefaultPanel = () => {
    setPanelWidth(Math.round(Math.min(props.maxWidth(), Math.max(PANEL_MIN, defaultPanelWidth()))));
  };

  return (
    <aside id="file-preview-panel" class="browser-panel file-preview-panel" aria-label="File preview">
      <PanelResizer
        class="right-panel-resizer"
        label="Resize file preview"
        controls="file-preview-panel"
        direction="right"
        value={panelWidth()}
        defaultValue={defaultPanelWidth()}
        min={PANEL_MIN}
        max={props.maxWidth}
        onResize={setPanelWidth}
        onResizeEnd={(width) => savePanelWidth(PANEL_STORAGE_KEY, width)}
        onParentResize={resizeDefaultPanel}
        onReset={() => {
          window.localStorage.removeItem(PANEL_STORAGE_KEY);
          setPanelWidth(defaultPanelWidth());
        }}
      />
      <header class="file-preview-header">
        <File class="file-preview-file-icon" />
        <h2 title={props.preview.name}>{props.preview.name}</h2>
        <Button
          type="button"
          class="browser-toolbar-button"
          aria-label="Open file externally"
          onClick={props.onOpenExternally}
        >
          <ExternalLink class="browser-toolbar-icon" />
        </Button>
        <Button type="button" class="browser-toolbar-button" aria-label="Close file preview" onClick={props.onClose}>
          <X class="browser-toolbar-icon" />
        </Button>
      </header>
      <div class="file-preview-content">
        <Show when={props.preview.previewKind === "markdown"}>
          <article class="file-preview-markdown message-markdown">
            <MarkdownMessageText
              body={text().value}
              bots={props.bots}
              attachments={[]}
              citations={[]}
              showCitationFooter={false}
              onSelectAgent={() => undefined}
              onOpenLink={props.onOpenLink}
              onOpenSharedFile={props.onOpenSharedFile}
              onOpenWorkspaceFile={props.onOpenWorkspaceFile}
            />
          </article>
        </Show>
        <Show when={props.preview.previewKind === "text"}>
          <pre class="file-preview-text">{text().value}</pre>
        </Show>
        <Show when={props.preview.previewKind === "image" && previewUrl()}>
          <div class="file-preview-image-wrap">
            <img class="file-preview-image" src={previewUrl() ?? ""} alt={props.preview.name} />
          </div>
        </Show>
        <Show when={props.preview.previewKind === "pdf" && previewUrl()}>
          <iframe class="file-preview-pdf" title={props.preview.name} src={previewUrl() ?? ""} />
        </Show>
        <Show when={props.preview.previewKind === "none"}>
          <div class="file-preview-unsupported">
            <File />
            <strong>Preview unavailable</strong>
            <span>This file type can be opened in its default application.</span>
            <Button type="button" onClick={props.onOpenExternally}>
              Open externally
            </Button>
          </div>
        </Show>
        <Show when={text().truncated}>
          <p class="file-preview-truncated">Preview truncated after 1,000,000 characters.</p>
        </Show>
      </div>
    </aside>
  );
}
