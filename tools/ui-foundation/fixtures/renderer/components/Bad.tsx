// Breaks all five per-file checks at once: a native control, a Kobalte import outside
// components/ui, a hand-written switch, an inline colour literal, and an inline radius.
import { Popover } from "@kobalte/core/popover";

export function Bad() {
  return (
    <button role="switch" style={{ color: "#ff0000", "border-radius": "6px" }}>
      <input />
      <Popover />
    </button>
  );
}
