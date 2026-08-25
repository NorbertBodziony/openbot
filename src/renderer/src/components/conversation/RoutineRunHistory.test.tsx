import type { RoutineRun } from "@openbot/contracts/ipc";
import { render, screen } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { RoutineRunHistory } from "./RoutineRunHistory";

const statuses: RoutineRun["status"][] = [
  "queued",
  "running",
  "needs-attention",
  "succeeded",
  "failed",
  "interrupted",
  "cancelled",
];

describe("RoutineRunHistory", () => {
  it("renders an accessible icon for every run status", () => {
    render(() => <RoutineRunHistory runs={statuses.map(runForStatus)} />);

    for (const status of statuses) {
      const label = status === "needs-attention" ? "Needs attention" : `${status[0]?.toUpperCase()}${status.slice(1)}`;
      expect(screen.getByRole("img", { name: label })).toBeInTheDocument();
    }
    expect(screen.getByText(/Manual ·/)).toBeInTheDocument();
  });
});

function runForStatus(status: RoutineRun["status"], index: number): RoutineRun {
  const scheduledFor = new Date(Date.now() - index * 3_600_000).toISOString();
  return {
    id: `run-${status}`,
    routineId: "routine-1",
    botId: "chief",
    triggerId: index === 0 ? null : "trigger-1",
    kind: index === 0 ? "manual" : "scheduled",
    scheduledFor,
    routineName: "Morning brief",
    instruction: "Prepare the brief.",
    deliveryId: `delivery-${status}`,
    status,
    error: status === "failed" ? "Example failure" : null,
    createdAt: scheduledFor,
    updatedAt: scheduledFor,
  };
}
