import { describe, expect, it } from "vitest";
import { messageContentBlocks } from "./DataTable";

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

  it("recognizes a feature matrix when every option cell uses comparison markers", () => {
    expect(
      messageContentBlocks(
        [
          "| Feature | Personal | Enterprise |",
          "| --- | --- | --- |",
          "| Unlimited projects | ✓ | ✓ |",
          "| Priority support | — | ✓ |",
        ].join("\n"),
      ),
    ).toEqual([
      {
        type: "comparison-table",
        headers: ["Feature", "Personal", "Enterprise"],
        rows: [
          ["Unlimited projects", "✓", "✓"],
          ["Priority support", "—", "✓"],
        ],
      },
    ]);
  });

  it("keeps mixed-value matrices as regular data tables", () => {
    expect(
      messageContentBlocks("| Feature | Personal | Enterprise |\n| --- | --- | --- |\n| Projects | 3 | ✓ |"),
    ).toMatchObject([{ type: "table" }]);
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

  it("parses fenced code with a language and filename", () => {
    expect(
      messageContentBlocks(
        ["Use this helper:", "", "```ts churn.ts", 'export const flavor = "pistachio";', "```", "", "Done."].join("\n"),
      ),
    ).toEqual([
      { type: "text", text: "Use this helper:" },
      {
        type: "code",
        code: 'export const flavor = "pistachio";',
        language: "ts",
        filename: "churn.ts",
      },
      { type: "text", text: "Done." },
    ]);
  });

  it("keeps table syntax inside a code fence as code", () => {
    expect(messageContentBlocks("```md\n| A | B |\n| --- | --- |\n| 1 | 2 |\n```")).toEqual([
      {
        type: "code",
        code: "| A | B |\n| --- | --- |\n| 1 | 2 |",
        language: "md",
      },
    ]);
  });

  it("renders an unfinished code fence only while the response streams", () => {
    const body = "```js\nconst answer = 4";

    expect(messageContentBlocks(body, true)).toEqual([{ type: "code", code: "const answer = 4", language: "js" }]);
    expect(messageContentBlocks(body, false)).toEqual([{ type: "text", text: body }]);
  });
});
