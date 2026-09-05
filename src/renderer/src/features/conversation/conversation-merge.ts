/**
 * Which messages a conversation shows after a page or a snapshot arrives.
 *
 * Pure, and separate from `conversation-read-state.ts`, because this is list
 * arithmetic over whatever the caller stores rather than anything about read
 * state: `conversation.tsx` passes the stored message objects it already holds
 * so identity survives a merge, and the renderer only re-animates what is
 * genuinely new.
 *
 * Both functions exist because a conversation can be showing a window into a
 * longer history - older pages the user scrolled back to, or a page loaded
 * *around* a searched message - and main sends the tail of that history without
 * knowing what is on screen. Dropping the loaded prefix would scroll the user
 * away from what they were reading.
 */

/**
 * How a page joins what is already loaded: `replace` for a fresh window,
 * `older` for one prepended by scrolling back, `latest` for one appended at the
 * end.
 */
export type ConversationPageMerge = "replace" | "older" | "latest";

/**
 * A page joined to the loaded messages, with the page's copy of any message
 * that appears in both. Ordering is the caller's `merge`; de-duplication is by
 * id, so a page that overlaps the loaded range moves those messages rather than
 * showing them twice.
 */
export function mergeConversationPage<Message extends { id: string }>(
  loaded: readonly Message[],
  page: readonly Message[],
  merge: ConversationPageMerge,
): Message[] {
  if (merge === "replace") return [...page];
  const pageIds = new Set(page.map((message) => message.id));
  const kept = loaded.filter((message) => !pageIds.has(message.id));
  return merge === "older" ? [...page, ...kept] : [...kept, ...page];
}

/**
 * The part of a refreshed snapshot a conversation may show without losing its
 * window.
 *
 * A snapshot with nothing older left to load is the whole conversation, so it
 * is shown whole. Otherwise it is the tail, and what the user is looking at
 * decides how much of it applies: a window loaded *around* a message keeps only
 * messages already on screen, because anything else in the snapshot belongs to
 * the far end of a gap. A window at the latest end keeps those, plus everything
 * after the last one it recognises - that is the new arrivals, and it is why a
 * refresh does not drop the older pages loaded above them.
 */
export function windowedSnapshotMessages<Message extends { id: string }>(
  loaded: readonly Message[],
  snapshot: readonly Message[],
  window: { hasOlder: boolean; mode: "latest" | "around" },
): Message[] {
  if (!window.hasOlder) return [...snapshot];
  const loadedIds = new Set(loaded.map((message) => message.id));
  if (window.mode === "around") return snapshot.filter((message) => loadedIds.has(message.id));
  const lastLoadedIndex = snapshot.reduce((last, message, index) => (loadedIds.has(message.id) ? index : last), -1);
  return snapshot.filter((message, index) => loadedIds.has(message.id) || index > lastLoadedIndex);
}
