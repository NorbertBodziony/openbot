import { render, screen } from "@solidjs/testing-library";
import { For } from "solid-js";
import { describe, expect, it } from "vitest";
import { createChatVirtualizer } from "./createChatVirtualizer";

describe("chat virtualizer", () => {
  it("keeps fallback rows inside a list with a nonzero scroll margin", () => {
    let scrollElement: HTMLDivElement | undefined;

    function TestList() {
      const virtualizer = createChatVirtualizer<HTMLDivElement, HTMLDivElement>({
        count: () => 2,
        getScrollElement: () => scrollElement ?? null,
        estimateSize: () => 128,
        getItemKey: (index) => `message-${index}`,
        keyVersion: () => "message-0:message-1",
        scrollMargin: () => 64,
      });

      return (
        <div ref={(element) => (scrollElement = element)}>
          <For each={virtualizer.getVirtualItems()}>
            {(row) => (
              <div
                data-testid={`row-${row.index}`}
                style={{ transform: `translateY(${row.start - virtualizer.scrollMargin()}px)` }}
              />
            )}
          </For>
        </div>
      );
    }

    render(() => <TestList />);

    expect(screen.getByTestId("row-0")).toHaveStyle({ transform: "translateY(0px)" });
    expect(screen.getByTestId("row-1")).toHaveStyle({ transform: "translateY(128px)" });
  });
});
