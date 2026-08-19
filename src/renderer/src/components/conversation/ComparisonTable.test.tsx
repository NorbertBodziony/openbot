import { render, screen, within } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { ComparisonTable } from "./ComparisonTable";

describe("ComparisonTable", () => {
  it("renders an accessible feature matrix and treats labels as text", () => {
    render(() => (
      <ComparisonTable
        table={{
          type: "comparison-table",
          headers: ["Feature", "Personal", "Enterprise"],
          rows: [
            ["<strong>Unlimited projects</strong>", "✓", "✓"],
            ["Priority support", "—", "✓"],
          ],
        }}
      />
    ));

    const region = screen.getByRole("region", { name: "Comparison table" });
    const table = within(region).getByRole("table");
    expect(within(table).getAllByRole("columnheader")).toHaveLength(3);
    expect(within(table).getAllByRole("cell")).toHaveLength(6);
    expect(within(table).getByText("<strong>Unlimited projects</strong>")).toBeInTheDocument();
    expect(table.querySelector("strong")).toBeNull();
    expect(table.querySelectorAll(".message-comparison-table-yes")).toHaveLength(3);
    expect(table.querySelectorAll(".message-comparison-table-no")).toHaveLength(1);
  });
});
