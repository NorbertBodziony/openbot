// The other half of the Kobalte/Lucide check. `lucide-solid` is a separate package on a
// separate import path, so kobalte firing says nothing about this branch of the pattern.
import { Check } from "lucide-solid";

export function Icons() {
  return <Check />;
}
