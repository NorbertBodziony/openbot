// Inside components/ui, where Kobalte lives. The script reads this one file to check
// how the namespace is re-exported.
import { Dialog as DialogPrimitive } from "@kobalte/core/dialog";
import { Tabs as TabsPrimitive } from "@kobalte/core/tabs";

// Correct: the namespace passes through an adapter, so the renderer never sees Kobalte.
export const Dialog = Object.assign(DialogPrimitive.Root, { Trigger: DialogPrimitive.Trigger });

// Wrong: a direct alias hands the whole primitive to callers unchanged.
export const Tabs = TabsPrimitive;
