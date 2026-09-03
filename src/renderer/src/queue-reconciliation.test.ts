import type { QueueDelivery, QueueDeliveryStatus, QueueSnapshot } from "@openbot/contracts/ipc";
import {
  activeQueueDeliveries,
  presentQueueDeliveries,
  queueAfterTurnCompleted,
  queuedDeliveriesInOrder,
} from "./queue-reconciliation";

interface DeliveryOverrides {
  id: string;
  status: QueueDeliveryStatus;
  turnId?: string | null;
  position?: number | null;
  createdAt?: string;
}

function delivery(overrides: DeliveryOverrides): QueueDelivery {
  return {
    id: overrides.id,
    messageId: `message-${overrides.id}`,
    recipientBotId: "chief",
    sender: { kind: "user" },
    text: "Do the thing",
    attachments: [],
    replyToMessageId: null,
    status: overrides.status,
    position: overrides.position ?? null,
    turnId: overrides.turnId ?? null,
    error: null,
    createdAt: overrides.createdAt ?? "2026-08-12T10:00:00.000Z",
  };
}

const snapshot = (...deliveries: QueueDelivery[]): QueueSnapshot => ({ botId: "chief", deliveries });
const ids = (deliveries: readonly QueueDelivery[]) => deliveries.map((entry) => entry.id);

describe("activeQueueDeliveries", () => {
  it("takes only the work that has started", () => {
    const queue = snapshot(
      delivery({ id: "waiting", status: "queued" }),
      delivery({ id: "starting", status: "starting" }),
      delivery({ id: "running", status: "running" }),
      delivery({ id: "done", status: "completed" }),
      delivery({ id: "failed", status: "failed" }),
    );

    expect(ids(activeQueueDeliveries(queue, null))).toEqual(["starting", "running"]);
  });

  it("narrows to the running turn when the queue says which turn each belongs to", () => {
    const queue = snapshot(
      delivery({ id: "this-turn", status: "running", turnId: "turn-2" }),
      delivery({ id: "other-turn", status: "running", turnId: "turn-1" }),
      delivery({ id: "unassigned", status: "starting", turnId: null }),
    );

    expect(ids(activeQueueDeliveries(queue, "turn-2"))).toEqual(["this-turn", "unassigned"]);
  });

  it("keeps showing started work whose turn is not recorded yet", () => {
    const queue = snapshot(delivery({ id: "other-turn", status: "running", turnId: "turn-1" }));

    expect(ids(activeQueueDeliveries(queue, "turn-2"))).toEqual(["other-turn"]);
  });

  it("has nothing to show without a queue", () => {
    expect(activeQueueDeliveries(undefined, "turn-1")).toEqual([]);
  });
});

describe("queuedDeliveriesInOrder", () => {
  it("orders waiting work by the position main assigned", () => {
    const queue = snapshot(
      delivery({ id: "second", status: "queued", position: 2 }),
      delivery({ id: "first", status: "queued", position: 1 }),
      delivery({ id: "running", status: "running", position: 0 }),
    );

    expect(ids(queuedDeliveriesInOrder(queue))).toEqual(["first", "second"]);
  });

  it("puts work main has not positioned yet last, in arrival order", () => {
    const queue = snapshot(
      delivery({ id: "later", status: "queued", createdAt: "2026-08-12T10:00:02.000Z" }),
      delivery({ id: "earlier", status: "queued", createdAt: "2026-08-12T10:00:01.000Z" }),
      delivery({ id: "positioned", status: "queued", position: 5 }),
    );

    expect(ids(queuedDeliveriesInOrder(queue))).toEqual(["positioned", "earlier", "later"]);
  });
});

describe("presentQueueDeliveries", () => {
  const present = (queue: QueueSnapshot | undefined, activeTurnId: string | null, rendered: string[] = []) =>
    ids(presentQueueDeliveries({ snapshot: queue, activeTurnId, renderedMessageIds: new Set(rendered) }));

  it("shows nothing between turns, however much is waiting", () => {
    const queue = snapshot(
      delivery({ id: "waiting", status: "queued", position: 1 }),
      delivery({ id: "done", status: "completed" }),
    );

    expect(present(queue, null)).toEqual([]);
  });

  it("shows what is waiting behind the running turn", () => {
    const queue = snapshot(
      delivery({ id: "running", status: "running", turnId: "turn-1" }),
      delivery({ id: "waiting", status: "queued", position: 1 }),
    );

    expect(present(queue, "turn-1")).toEqual(["waiting"]);
  });

  it("leaves the running turn's own queued work to the activity line", () => {
    const queue = snapshot(
      delivery({ id: "running", status: "running", turnId: "turn-1" }),
      delivery({ id: "this-turn", status: "queued", turnId: "turn-1", position: 1 }),
      delivery({ id: "next-turn", status: "queued", position: 2 }),
    );

    expect(present(queue, "turn-1")).toEqual(["next-turn"]);
  });

  it("adds a steer of the running turn after the waiting work", () => {
    const queue = snapshot(
      delivery({ id: "running", status: "running", turnId: "turn-1" }),
      delivery({ id: "steer", status: "starting", turnId: "turn-1" }),
      delivery({ id: "waiting", status: "queued", position: 1 }),
    );

    expect(present(queue, "turn-1")).toEqual(["waiting", "steer"]);
  });

  it("leaves out work the transcript is already showing", () => {
    const queue = snapshot(
      delivery({ id: "running", status: "running", turnId: "turn-1" }),
      delivery({ id: "steer", status: "starting", turnId: "turn-1" }),
      delivery({ id: "waiting", status: "queued", position: 1 }),
    );

    expect(present(queue, "turn-1", ["waiting", "steer"])).toEqual([]);
  });

  it("has nothing to show without a queue", () => {
    expect(present(undefined, "turn-1")).toEqual([]);
  });
});

describe("queueAfterTurnCompleted", () => {
  it("drops the work the finished turn was running", () => {
    const queue = snapshot(
      delivery({ id: "ran", status: "running", turnId: "turn-1" }),
      delivery({ id: "waiting", status: "queued", position: 1 }),
    );

    expect(ids(queueAfterTurnCompleted(queue, "turn-1").deliveries)).toEqual(["waiting"]);
  });

  it("drops started work main has not assigned a turn to", () => {
    const queue = snapshot(delivery({ id: "starting", status: "starting", turnId: null }));

    expect(queueAfterTurnCompleted(queue, "turn-1").deliveries).toEqual([]);
  });

  it("leaves another turn's work running", () => {
    const queue = snapshot(delivery({ id: "other", status: "running", turnId: "turn-2" }));

    expect(ids(queueAfterTurnCompleted(queue, "turn-1").deliveries)).toEqual(["other"]);
  });

  it("returns the same queue when the turn had nothing running", () => {
    const queue = snapshot(delivery({ id: "waiting", status: "queued", position: 1 }));

    expect(queueAfterTurnCompleted(queue, "turn-1")).toBe(queue);
  });
});
