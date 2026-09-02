import { render, screen, within } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { DataTable } from "./DataTable";

describe("DataTable", () => {
  it("renders an accessible semantic table and treats cell markup as text", () => {
    render(() => (
      <DataTable
        table={{
          type: "table",
          headers: ["Model", "Context"],
          alignments: ["left", "right"],
          rows: [["<strong>gpt-4o</strong>", "128k"]],
        }}
      />
    ));

    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("columnheader")).toHaveLength(2);
    expect(within(table).getAllByRole("cell")).toHaveLength(2);
    expect(within(table).getByText("<strong>gpt-4o</strong>")).toBeInTheDocument();
    expect(table.querySelector("strong")).toBeNull();
  });
});
