import { render, screen, waitFor } from "@solidjs/testing-library";
import { createMemo, createSignal, For } from "solid-js";
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
      const rows = createMemo(() => virtualizer.getVirtualItems());

      return (
        <div ref={(element) => (scrollElement = element)}>
          <For each={rows()}>
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

  it("renders an appended row without entering a refresh loop", async () => {
    let appendMessage: (() => void) | undefined;

    function TestList() {
      const [messageIds, setMessageIds] = createSignal(["message-0"]);
      appendMessage = () => setMessageIds((current) => [...current, "message-1"]);
      const virtualizer = createChatVirtualizer<HTMLDivElement, HTMLDivElement>({
        count: () => messageIds().length,
        getScrollElement: () => null,
        estimateSize: () => 128,
        getItemKey: (index) => messageIds()[index] ?? index,
        keyVersion: () => messageIds().join(":"),
        scrollMargin: () => 0,
      });
      const rows = createMemo(() => virtualizer.getVirtualItems());

      return <For each={rows()}>{(row) => <div data-testid={`dynamic-row-${row.index}`}>{String(row.key)}</div>}</For>;
    }

    render(() => <TestList />);
    expect(screen.getByTestId("dynamic-row-0")).toHaveTextContent("message-0");

    appendMessage?.();

    await waitFor(() => expect(screen.getByTestId("dynamic-row-1")).toHaveTextContent("message-1"));
  });
});
