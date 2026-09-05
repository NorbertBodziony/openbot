// The adapter shape the namespace check must accept. It lives in its own tree because that
// check reports at most one failure per file: pairing it with a direct alias in the fixture
// that breaks the check would let the alias account for the failure while a widened pattern
// quietly started rejecting this too.
import { Dialog as DialogPrimitive } from "@kobalte/core/dialog";
import { Tabs as TabsPrimitive } from "@kobalte/core/tabs";

export const Dialog = Object.assign(DialogPrimitive.Root, { Trigger: DialogPrimitive.Trigger });
export const Tabs = Object.assign(TabsPrimitive.Root, { List: TabsPrimitive.List });
