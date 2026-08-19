import { For } from "solid-js";

export type DataTableAlignment = "left" | "center" | "right";

export interface DataTableBlock {
  type: "table";
  headers: string[];
  alignments: DataTableAlignment[];
  rows: string[][];
}

export interface MessageTextBlock {
  type: "text";
  text: string;
}

export type MessageContentBlock = DataTableBlock | MessageTextBlock;

export function DataTable(props: { table: DataTableBlock }) {
  return (
    <section class="message-data-table-scroll" aria-label="Data table" tabindex="0">
      <table class="message-data-table" style={`--message-data-table-columns: ${props.table.headers.length}`}>
        <thead>
          <tr>
            <For each={props.table.headers}>
              {(header, index) => (
                <th scope="col" data-align={props.table.alignments[index()]}>
                  {header}
                </th>
              )}
            </For>
          </tr>
        </thead>
        <tbody>
          <For each={props.table.rows}>
            {(row) => (
              <tr>
                <For each={row}>{(cell, index) => <td data-align={props.table.alignments[index()]}>{cell}</td>}</For>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </section>
  );
}

export function messageContentBlocks(body: string, streaming = false): MessageContentBlock[] {
  const lines = body.split("\n");
  const blocks: MessageContentBlock[] = [];
  let textLines: string[] = [];
  let foundTable = false;

  const flushText = () => {
    while (textLines[0] === "") textLines.shift();
    while (textLines.at(-1) === "") textLines.pop();
    if (textLines.length > 0) blocks.push({ type: "text", text: textLines.join("\n") });
    textLines = [];
  };

  for (let index = 0; index < lines.length; ) {
    const table = parseTableAt(lines, index, streaming && !body.endsWith("\n"));
    if (!table) {
      textLines.push(lines[index] ?? "");
      index += 1;
      continue;
    }

    flushText();
    blocks.push(table.block);
    foundTable = true;
    index = table.nextIndex;
  }

  flushText();
  return foundTable ? blocks : [{ type: "text", text: body }];
}

function parseTableAt(
  lines: string[],
  startIndex: number,
  incompleteLastLine: boolean,
): { block: DataTableBlock; nextIndex: number } | null {
  if (startIndex + 2 >= lines.length) return null;
  if (incompleteLastLine && startIndex + 1 === lines.length - 1) return null;

  const headers = parseRow(lines[startIndex] ?? "");
  const separatorCells = parseRow(lines[startIndex + 1] ?? "");
  if (!headers || headers.length < 2 || !separatorCells || separatorCells.length !== headers.length) return null;

  const alignments: DataTableAlignment[] = [];
  for (const separator of separatorCells) {
    const alignment = separatorAlignment(separator);
    if (!alignment) return null;
    alignments.push(alignment);
  }

  const rows: string[][] = [];
  let nextIndex = startIndex + 2;
  while (nextIndex < lines.length) {
    if (incompleteLastLine && nextIndex === lines.length - 1) break;
    const line = lines[nextIndex] ?? "";
    const row = parseRow(line);
    if (!row) {
      if (hasUnescapedPipe(line.trim())) return null;
      break;
    }
    if (row.length !== headers.length) return null;
    rows.push(row);
    nextIndex += 1;
  }
  if (rows.length === 0) return null;

  return {
    block: {
      type: "table",
      headers,
      alignments,
      rows,
    },
    nextIndex,
  };
}

function parseRow(line: string): string[] | null {
  let source = line.trim();
  if (!hasUnescapedPipe(source)) return null;
  if (source.startsWith("|")) source = source.slice(1);
  if (endsWithUnescapedPipe(source)) source = source.slice(0, -1);

  const cells: string[] = [];
  let cell = "";
  let escaped = false;
  for (const character of source) {
    if (escaped) {
      cell += character === "|" || character === "\\" ? character : `\\${character}`;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "|") {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += character;
  }
  if (escaped) cell += "\\";
  cells.push(cell.trim());
  return cells.length >= 2 ? cells : null;
}

function hasUnescapedPipe(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "|") continue;
    let slashCount = 0;
    for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) slashCount += 1;
    if (slashCount % 2 === 0) return true;
  }
  return false;
}

function endsWithUnescapedPipe(value: string): boolean {
  if (!value.endsWith("|")) return false;
  let slashCount = 0;
  for (let index = value.length - 2; index >= 0 && value[index] === "\\"; index -= 1) slashCount += 1;
  return slashCount % 2 === 0;
}

function separatorAlignment(value: string): DataTableAlignment | null {
  if (!/^:?-{3,}:?$/u.test(value)) return null;
  if (value.startsWith(":") && value.endsWith(":")) return "center";
  return value.endsWith(":") ? "right" : "left";
}
