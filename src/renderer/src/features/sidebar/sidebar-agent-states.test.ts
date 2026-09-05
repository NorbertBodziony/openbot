import type { QueueDelivery, QueueDeliveryStatus, QueueSnapshot } from "@openbot/contracts/ipc";
import { computeSidebarAgentStates, type SidebarAgentStatesInput } from "./sidebar-agent-states";

function queue(agentId: string, ...statuses: QueueDeliveryStatus[]): QueueSnapshot {
  const deliveries: QueueDelivery[] = statuses.map((status, index) => ({
    id: `delivery-${index}`,
    messageId: `message-${index}`,
    recipientAgentId: agentId,
    sender: { kind: "user" },
    text: "Do the thing",
    attachments: [],
    replyToMessageId: null,
    status,
    position: index,
    turnId: null,
    error: null,
    createdAt: "2026-08-12T10:00:00.000Z",
  }));
  return { agentId, deliveries };
}

function input(overrides: Partial<SidebarAgentStatesInput> = {}): SidebarAgentStatesInput {
  return {
    agentIds: ["chief"],
    activeTurns: {},
    queues: {},
    unreadReplies: {},
    recentReplies: {},
    ...overrides,
  };
}

describe("computeSidebarAgentStates", () => {
  it("shows working while a turn runs, over the replies waiting to be read", () => {
    const states = computeSidebarAgentStates(
      input({
        activeTurns: { chief: "turn-1" },
        unreadReplies: { chief: 3 },
        recentReplies: { chief: true },
      }),
    );

    expect(states.chief).toEqual({ kind: "working" });
  });

  it("shows working for a queued delivery only once it has started", () => {
    const dormant = computeSidebarAgentStates(input({ queues: { chief: queue("chief", "queued", "failed") } }));
    expect(dormant.chief).toBeUndefined();

    for (const status of ["starting", "running"] as const) {
      const states = computeSidebarAgentStates(input({ queues: { chief: queue("chief", "queued", status) } }));
      expect(states.chief).toEqual({ kind: "working" });
    }
  });

  it("counts unread replies ahead of the completed indicator", () => {
    const states = computeSidebarAgentStates(input({ unreadReplies: { chief: 2 }, recentReplies: { chief: true } }));

    expect(states.chief).toEqual({ kind: "unread", count: 2 });
  });

  it("falls back to the completed indicator once the replies are read", () => {
    const states = computeSidebarAgentStates(input({ unreadReplies: { chief: 0 }, recentReplies: { chief: true } }));

    expect(states.chief).toEqual({ kind: "responded" });
  });

  it("leaves an idle agent out of the result rather than describing it", () => {
    const states = computeSidebarAgentStates(
      input({
        agentIds: ["chief", "sales"],
        activeTurns: { sales: null },
        queues: { sales: queue("sales", "completed") },
        unreadReplies: { chief: 1 },
      }),
    );

    expect(states).toEqual({ chief: { kind: "unread", count: 1 } });
  });

  it("describes only the agents it was given", () => {
    const states = computeSidebarAgentStates(input({ agentIds: [], activeTurns: { chief: "turn-1" } }));

    expect(states).toEqual({});
  });
});
