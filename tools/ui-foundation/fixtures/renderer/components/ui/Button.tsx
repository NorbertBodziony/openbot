// Also inside components/ui, and therefore exempt from every per-file check. A native
// control, a Kobalte import, a hand-written switch, a colour literal and a composite
// ARIA role are all allowed here, and none of them may appear in the report. The one
// exception is the data-testid: that budget has no exempt directory, so this is its
// sixth occurrence and the only one that fails if the scan starts skipping components/ui.
import { Button as ButtonPrimitive } from "@kobalte/core/button";

export function Button() {
  return (
    <div role="dialog" data-testid="hook-six">
      <button role="switch" style={{ color: "#ffffff", "border-radius": "6px" }} />
      <ButtonPrimitive />
    </div>
  );
}
