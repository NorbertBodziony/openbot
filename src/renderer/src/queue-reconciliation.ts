import type { QueueDelivery, QueueSnapshot } from "@openbot/contracts/ipc";

/**
 * Which of an agent's queue the conversation shows, and in what order.
 *
 * Main sends the whole queue - everything waiting, everything running, and
 * everything that has finished - and the conversation shows two much smaller
 * things: what the agent is doing now, above the composer, and what is still
 * waiting behind it, in the queue panel. Deciding which is which is list
 * arithmetic over a snapshot, so it lives here rather than in the three memos
 * it used to be spread across in `ConversationView`.
 */

/**
 * What the agent is working on. Narrowed to the current turn when there is one,
 * unless nothing in the queue claims that turn - a delivery whose turn has not
 * been recorded yet is still work in progress, and hiding it would blank the
 * activity line mid-turn.
 */
export function activeQueueDeliveries(
  snapshot: QueueSnapshot | undefined,
  activeTurnId: string | null | undefined,
): QueueDelivery[] {
  const running = (snapshot?.deliveries ?? []).filter(
    (delivery) => delivery.status === "starting" || delivery.status === "running",
  );
  if (!activeTurnId) return running;
  const matching = running.filter((delivery) => delivery.turnId === activeTurnId || delivery.turnId === null);
  return matching.length > 0 ? matching : running;
}

/**
 * What is still waiting, in the order it will run: by the position main
 * assigned, and by arrival for anything main has not positioned yet.
 */
export function queuedDeliveriesInOrder(snapshot: QueueSnapshot | undefined): QueueDelivery[] {
  return [...(snapshot?.deliveries ?? [])]
    .filter((delivery) => delivery.status === "queued")
    .sort((left, right) => {
      const leftPosition = left.position ?? Number.MAX_SAFE_INTEGER;
      const rightPosition = right.position ?? Number.MAX_SAFE_INTEGER;
      return leftPosition - rightPosition || left.createdAt.localeCompare(right.createdAt);
    });
}

/**
 * The queue panel's contents: what is waiting, then anything steering the turn
 * that is running.
 *
 * Empty between turns. A queue with nothing running is work the user has
 * already seen land in the transcript, so showing it again would be a panel
 * that never goes away. Two more things drop out: a delivery already rendered
 * as a message, which the transcript is showing, and a queued delivery that
 * belongs to the running turn, which the activity line above is showing.
 */
export function presentQueueDeliveries(input: {
  snapshot: QueueSnapshot | undefined;
  activeTurnId: string | null | undefined;
  renderedMessageIds: ReadonlySet<string>;
}): QueueDelivery[] {
  const snapshot = input.snapshot;
  if (!snapshot || activeQueueDeliveries(snapshot, input.activeTurnId).length === 0) return [];
  const queued = queuedDeliveriesInOrder(snapshot).filter(
    (delivery) =>
      (!input.activeTurnId || delivery.turnId !== input.activeTurnId) && !input.renderedMessageIds.has(delivery.id),
  );
  const steering = snapshot.deliveries.filter(
    (delivery) =>
      delivery.status === "starting" &&
      Boolean(input.activeTurnId) &&
      delivery.turnId === input.activeTurnId &&
      !input.renderedMessageIds.has(delivery.id),
  );
  return [...queued, ...steering];
}

/**
 * The queue once a turn has finished, with the work that turn was running
 * dropped.
 *
 * Main reports the completion before it reports the queue that reflects it, so
 * without this the panel keeps offering to cancel work that has already landed
 * in the transcript. Deliveries with no recorded turn go too - a delivery main
 * has not assigned a turn to was started by the turn that just ended.
 *
 * Returns the snapshot it was given when nothing matched, so a caller can leave
 * its state untouched rather than re-render an identical queue.
 */
export function queueAfterTurnCompleted(snapshot: QueueSnapshot, turnId: string): QueueSnapshot {
  const deliveries = snapshot.deliveries.filter(
    (delivery) =>
      !(
        (delivery.status === "starting" || delivery.status === "running") &&
        (delivery.turnId === null || delivery.turnId === turnId)
      ),
  );
  return deliveries.length === snapshot.deliveries.length ? snapshot : { ...snapshot, deliveries };
}
