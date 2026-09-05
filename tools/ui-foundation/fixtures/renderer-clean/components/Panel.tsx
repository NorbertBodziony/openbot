// A feature component that breaks nothing: a shared primitive instead of a native control,
// palette tokens instead of literals, and a role the composite ratchet does not count.
import { Dialog } from "./ui/complex";

export function Panel() {
  return (
    <section role="group" style={{ color: "var(--openbot-text)", transition: "var(--openbot-transition)" }}>
      <Dialog />
    </section>
  );
}
