import { getOwner, isDisposed } from "solid-js";

/**
 * "Is the owner that created this guard still the one on screen?"
 *
 * Every per-server domain used to answer that with `activeServerId() !== serverId`
 * against a server id captured before the await. Under the keyed scope in
 * `app-providers.tsx` that comparison is a proxy for the real question and gets
 * one case wrong: leave a server and come back while a request is still in
 * flight, and the id matches again even though the owner that started the request
 * was disposed in between. The stale reply then writes to state that outlives the
 * scope - the read-tracking sets, the error feed - and asks main for work nobody
 * is waiting for.
 *
 * `isDisposed` answers the question directly, so A -> B -> A behaves like A -> B.
 * Call it in `init`, where the owner is the provider's; the returned predicate can
 * then be used from any callback, including one that resolves after disposal.
 *
 * It is not a replacement for the per-request counters that sit beside it.
 * `browserChangeRevision`, `directConversationRequest` and the rest order writes
 * *within* one owner - which of two concurrent loads for the same server wins -
 * and that ordering is invisible to disposal.
 */
export function createScopeGuard(): () => boolean {
  const owner = getOwner();
  return () => !(owner && isDisposed(owner));
}
