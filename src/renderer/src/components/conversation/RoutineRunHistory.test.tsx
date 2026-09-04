import type { RoutineRun } from "@openbot/contracts/ipc";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
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

  it("shows only the latest ten runs and opens their chat messages", async () => {
    const onOpenRun = vi.fn();
    const runs = Array.from({ length: 11 }, (_, index) => ({
      ...runForStatus("succeeded", index),
      id: `run-${index}`,
      deliveryId: `delivery-${index}`,
    }));
    render(() => <RoutineRunHistory runs={runs} onOpenRun={onOpenRun} />);

    const links = screen.getAllByRole("button", { name: /^Open .* in chat$/ });
    expect(links).toHaveLength(10);
    expect(screen.getAllByRole("img", { name: "Succeeded" })).toHaveLength(10);
    const firstLink = links[0];
    if (!firstLink) throw new Error("Expected the latest routine run link.");
    await fireEvent.click(firstLink);
    expect(onOpenRun).toHaveBeenCalledWith("delivery-0");
  });

  it("keeps a run without a conversation message non-interactive", () => {
    render(() => <RoutineRunHistory runs={[{ ...runForStatus("failed", 0), deliveryId: null }]} onOpenRun={vi.fn()} />);

    expect(screen.queryByRole("button", { name: /in chat$/ })).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Failed" })).toBeInTheDocument();
  });
});

function runForStatus(status: RoutineRun["status"], index: number): RoutineRun {
  const scheduledFor = new Date(Date.now() - index * 3_600_000).toISOString();
  return {
    id: `run-${status}`,
    routineId: "routine-1",
    agentId: "chief",
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
