import { createContext, type ParentProps, useContext } from "solid-js";
import type { createConversationController } from "./Conversation";

/**
 * The controller context lives outside `Conversation.tsx` so the view can read it without importing
 * `Conversation.tsx` back: `Conversation.tsx` imports the view, the view imports this module, and
 * nothing points back. Only the controller's *type* is borrowed, which the compiler erases.
 */
export type ConversationController = ReturnType<typeof createConversationController>;

const ConversationControllerContext = createContext<ConversationController>();

/** @internal Access to the stable controller for Conversation view components. */
export function useConversationController(): ConversationController {
  const controller = useContext(ConversationControllerContext);
  if (!controller) throw new Error("Conversation controller is unavailable outside Conversation.");
  return controller;
}

/** @internal Test seam for remounting view boundaries without remounting their controller. */
export function ConversationControllerProvider(props: ParentProps<{ controller: ConversationController }>) {
  return <ConversationControllerContext value={props.controller}>{props.children}</ConversationControllerContext>;
}
