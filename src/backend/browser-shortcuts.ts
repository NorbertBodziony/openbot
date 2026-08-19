interface BrowserShortcutInput {
  type: string;
  key: string;
  control: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}

export function isCloseBrowserTabShortcut(input: BrowserShortcutInput): boolean {
  return (
    input.type === "keyDown" &&
    input.key.toLowerCase() === "w" &&
    (input.control || input.meta) &&
    !input.alt &&
    !input.shift
  );
}

export function isGlobalSearchShortcut(input: BrowserShortcutInput): boolean {
  return (
    input.type === "keyDown" &&
    input.key.toLowerCase() === "k" &&
    (input.control || input.meta) &&
    !input.alt &&
    !input.shift
  );
}
