type ClipboardFileItem = Pick<DataTransferItem, "getAsFile" | "kind" | "type">;

interface ClipboardFileSource {
  files: ArrayLike<File>;
  items: ArrayLike<ClipboardFileItem>;
}

export function clipboardFiles(clipboard: ClipboardFileSource | null): File[] {
  if (!clipboard) return [];

  const files = Array.from(clipboard.files ?? []);
  if (files.length > 0) return files;

  return Array.from(clipboard.items ?? []).flatMap((item) => {
    if (item.kind !== "file") return [];
    const file = item.getAsFile();
    return file && (item.type.startsWith("image/") || file.type.startsWith("image/")) ? [file] : [];
  });
}
