export const IMAGE_ATTACHMENT_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "avif"] as const;

export const CONTEXT_ATTACHMENT_EXTENSIONS = [
  "pdf",
  "doc",
  "docx",
  "odt",
  "rtf",
  "xls",
  "xlsx",
  "ods",
  "ppt",
  "pptx",
  "odp",
  "txt",
  "md",
  "markdown",
  "csv",
  "json",
  "jsonl",
  "log",
  "xml",
  "yaml",
  "yml",
  "bash",
  "c",
  "cc",
  "conf",
  "cpp",
  "cs",
  "css",
  "cts",
  "env",
  "fish",
  "go",
  "gradle",
  "h",
  "hpp",
  "htm",
  "html",
  "ini",
  "ipynb",
  "java",
  "js",
  "jsx",
  "kt",
  "kts",
  "lock",
  "mjs",
  "mts",
  "php",
  "properties",
  "ps1",
  "py",
  "rb",
  "rs",
  "scala",
  "sh",
  "sql",
  "svelte",
  "swift",
  "toml",
  "ts",
  "tsx",
  "tex",
  "vue",
  "zsh",
] as const;

export const CONTAINER_ATTACHMENT_EXTENSIONS = ["eml", "zip"] as const;

export const ATTACHMENT_FILE_EXTENSIONS = [
  ...IMAGE_ATTACHMENT_EXTENSIONS,
  ...CONTEXT_ATTACHMENT_EXTENSIONS,
  ...CONTAINER_ATTACHMENT_EXTENSIONS,
] as const;

export const IMAGE_ATTACHMENT_ACCEPT = IMAGE_ATTACHMENT_EXTENSIONS.map((extension) => `.${extension}`).join(",");
export const ATTACHMENT_FILE_ACCEPT = ATTACHMENT_FILE_EXTENSIONS.map((extension) => `.${extension}`).join(",");
export const SUPPORTED_ATTACHMENT_DESCRIPTION = "images, PDF, Office documents, text, Markdown, data, or source files";
export const SUPPORTED_ATTACHMENT_IMPORT_DESCRIPTION =
  "images, PDF, Office documents, email, ZIP archives, text, Markdown, data, or source files";

const SUPPORTED_EXTENSIONS = new Set<string>([...IMAGE_ATTACHMENT_EXTENSIONS, ...CONTEXT_ATTACHMENT_EXTENSIONS]);
const SUPPORTED_IMPORT_EXTENSIONS = new Set<string>(ATTACHMENT_FILE_EXTENSIONS);
const EXTENSIONLESS_TEXT_FILES = new Set(["dockerfile", "makefile", "procfile"]);

export function attachmentFileExtension(name: string): string | null {
  const basename = name.split(/[\\/]/u).at(-1)?.trim().toLowerCase() ?? "";
  const dot = basename.lastIndexOf(".");
  return dot >= 0 && dot < basename.length - 1 ? basename.slice(dot + 1) : null;
}

export function isSupportedAttachmentName(name: string): boolean {
  const basename = name.split(/[\\/]/u).at(-1)?.trim().toLowerCase() ?? "";
  const extension = attachmentFileExtension(basename);
  return EXTENSIONLESS_TEXT_FILES.has(basename) || (extension !== null && SUPPORTED_EXTENSIONS.has(extension));
}

export function isSupportedAttachmentImportName(name: string): boolean {
  const basename = name.split(/[\\/]/u).at(-1)?.trim().toLowerCase() ?? "";
  const extension = attachmentFileExtension(basename);
  return EXTENSIONLESS_TEXT_FILES.has(basename) || (extension !== null && SUPPORTED_IMPORT_EXTENSIONS.has(extension));
}

export function attachmentMimeTypeForName(name: string) {
  switch (attachmentFileExtension(name)) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "avif":
      return "image/avif";
    case "pdf":
      return "application/pdf";
    case "eml":
      return "message/rfc822";
    case "zip":
      return "application/zip";
    case "doc":
      return "application/msword";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "odt":
      return "application/vnd.oasis.opendocument.text";
    case "rtf":
      return "application/rtf";
    case "xls":
      return "application/vnd.ms-excel";
    case "xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "ods":
      return "application/vnd.oasis.opendocument.spreadsheet";
    case "ppt":
      return "application/vnd.ms-powerpoint";
    case "pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case "odp":
      return "application/vnd.oasis.opendocument.presentation";
    case "md":
    case "markdown":
      return "text/markdown";
    case "json":
    case "jsonl":
    case "ipynb":
      return "application/json";
    default:
      return isSupportedAttachmentName(name) ? "text/plain" : "application/octet-stream";
  }
}
