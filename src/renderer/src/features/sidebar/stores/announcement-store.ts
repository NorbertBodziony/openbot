/**
 * The sidebar's one live region. Every reorder, move, pin and failure the user cannot see happen
 * announces here, so the store is the sink the rest of the sidebar writes to and reads nothing back.
 */

import { createSignal } from "solid-js";

export function createSidebarAnnouncementStore() {
  const [reorderAnnouncement, setReorderAnnouncement] = createSignal("");

  const announce = (message: string): void => {
    setReorderAnnouncement(message);
  };

  /**
   * A rejected layout mutation is what the user hears instead of the move they asked for, so the
   * cause is unwrapped here rather than at each of the seven call sites that used to spell it out.
   */
  const announceError = (cause: unknown): void => {
    setReorderAnnouncement(cause instanceof Error ? cause.message : String(cause));
  };

  return { announce, announceError, reorderAnnouncement };
}
