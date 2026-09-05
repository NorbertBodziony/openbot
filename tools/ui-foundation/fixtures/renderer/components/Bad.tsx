// Breaks all five per-file checks at once: a native control, a Kobalte import outside
// components/ui, a hand-written switch, an inline colour literal, and an inline radius.
// The native control is a <button> and nothing else: branches/NativeInput.tsx owns that
// branch, and a second control here would only mask which of the two this line proves.
import { Popover } from "@kobalte/core/popover";

export function Bad() {
  return (
    <button role="switch" style={{ color: "#ff0000", "border-radius": "6px" }}>
      <Popover />
    </button>
  );
}
