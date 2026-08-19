import { render, screen, within } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { DataTable, messageContentBlocks } from "./DataTable";

describe("messageContentBlocks", () => {
  it("parses GFM tables with optional outer pipes, alignment, and escaped pipes", () => {
    expect(
      messageContentBlocks(
        ["Before", "", "Name | Detail | Score", ":--- | :---: | ---:", "Alpha | one \\| two | 10", "", "After"].join(
          "\n",
        ),
      ),
    ).toEqual([
      { type: "text", text: "Before" },
      {
        type: "table",
        headers: ["Name", "Detail", "Score"],
        alignments: ["left", "center", "right"],
        rows: [["Alpha", "one | two", "10"]],
      },
      { type: "text", text: "After" },
    ]);
  });

  it("parses multiple tables in one response", () => {
    const blocks = messageContentBlocks(
      ["| A | B |", "| --- | --- |", "| 1 | 2 |", "", "Between", "", "C | D", "--- | ---", "3 | 4"].join("\n"),
    );

    expect(blocks.filter((block) => block.type === "table")).toHaveLength(2);
    expect(blocks).toContainEqual({ type: "text", text: "Between" });
  });

  it.each([
    "| A | B |\n| -- | --- |\n| 1 | 2 |",
    "| A | B |\n| --- | --- |\n| 1 | 2 | 3 |",
    "| A | B |\n| --- | --- |",
  ])("leaves malformed input as text", (body) => {
    expect(messageContentBlocks(body)).toEqual([{ type: "text", text: body }]);
  });

  it("does not consume an unfinished streaming row", () => {
    const body = "| A | B |\n| --- | --- |\n| 1 | 2 |\n| unfinished";

    expect(messageContentBlocks(body, true)).toEqual([
      {
        type: "table",
        headers: ["A", "B"],
        alignments: ["left", "left"],
        rows: [["1", "2"]],
      },
      { type: "text", text: "| unfinished" },
    ]);
    expect(messageContentBlocks(body, false)).toEqual([{ type: "text", text: body }]);
  });
});

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
