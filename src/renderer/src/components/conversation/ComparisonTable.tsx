import { For } from "solid-js";
import type { ComparisonTableBlock } from "./DataTable";

export function ComparisonTable(props: { table: ComparisonTableBlock }) {
  return (
    <section
      class="message-data-table-scroll message-comparison-table-scroll"
      aria-label="Comparison table"
      tabindex="0"
    >
      <table
        class="message-data-table message-comparison-table"
        style={`--message-data-table-columns: ${props.table.headers.length}`}
      >
        <thead>
          <tr>
            <For each={props.table.headers}>
              {(header) => (
                <th scope="col">
                  <span class="message-data-table-cell-text">{header}</span>
                </th>
              )}
            </For>
          </tr>
        </thead>
        <tbody>
          <For each={props.table.rows}>
            {(row) => (
              <tr>
                <For each={row}>
                  {(cell, index) => (
                    <td>
                      <span
                        class={
                          index() === 0
                            ? "message-data-table-cell-text"
                            : cell === "✓"
                              ? "message-comparison-table-yes"
                              : "message-comparison-table-no"
                        }
                      >
                        {cell}
                      </span>
                    </td>
                  )}
                </For>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </section>
  );
}
