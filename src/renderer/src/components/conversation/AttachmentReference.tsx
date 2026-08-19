const CODE_BADGES = new Set([
  "c",
  "cc",
  "cpp",
  "cs",
  "css",
  "go",
  "html",
  "java",
  "js",
  "jsx",
  "json",
  "md",
  "php",
  "py",
  "rb",
  "rs",
  "sql",
  "swift",
  "ts",
  "tsx",
  "vue",
]);

const DOCUMENT_BADGES = new Set(["doc", "docx", "odt", "pdf", "rtf"]);
const IMAGE_BADGES = new Set(["avif", "gif", "heic", "jpeg", "jpg", "png", "svg", "webp"]);
const ARCHIVE_BADGES = new Set(["7z", "gz", "rar", "tar", "zip"]);
const DATA_BADGES = new Set(["csv", "ods", "xls", "xlsx"]);
const PRESENTATION_BADGES = new Set(["odp", "ppt", "pptx"]);
const MEDIA_BADGES = new Set(["avi", "flac", "m4a", "mkv", "mov", "mp3", "mp4", "ogg", "wav", "webm"]);
const BADGED_EXTENSIONS = new Set([
  ...CODE_BADGES,
  ...DOCUMENT_BADGES,
  ...IMAGE_BADGES,
  ...ARCHIVE_BADGES,
  ...DATA_BADGES,
  ...PRESENTATION_BADGES,
  ...MEDIA_BADGES,
]);

export function attachmentReferenceBadge(name: string): string | null {
  const extension = name.split(".").at(-1)?.toLocaleLowerCase() ?? "";
  return BADGED_EXTENSIONS.has(extension) ? extension.slice(0, 4).toLocaleUpperCase() : null;
}

export function AttachmentReferenceVisual(props: { name: string }) {
  const badge = () => attachmentReferenceBadge(props.name);
  return (
    <span class="attachment-reference-visual" data-badge-length={badge()?.length.toString()} aria-hidden="true">
      {badge() ? <span>{badge()}</span> : <AttachmentReferenceFileIcon />}
    </span>
  );
}

export function appendAttachmentReferenceVisual(target: HTMLElement, name: string): void {
  const visual = document.createElement("span");
  visual.className = "attachment-reference-visual";
  visual.setAttribute("aria-hidden", "true");
  const badge = attachmentReferenceBadge(name);
  if (badge) {
    visual.dataset.badgeLength = badge.length.toString();
    const label = document.createElement("span");
    label.textContent = badge;
    visual.append(label);
  } else {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 20 20");
    const page = document.createElementNS("http://www.w3.org/2000/svg", "path");
    page.setAttribute("d", "M5 2.75h6l4 4v10.5H5z");
    const fold = document.createElementNS("http://www.w3.org/2000/svg", "path");
    fold.setAttribute("d", "M11 2.75v4h4M7.5 11h5M7.5 14h5");
    svg.append(page, fold);
    visual.append(svg);
  }
  target.append(visual);
}

function AttachmentReferenceFileIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="M5 2.75h6l4 4v10.5H5z" />
      <path d="M11 2.75v4h4M7.5 11h5M7.5 14h5" />
    </svg>
  );
}
