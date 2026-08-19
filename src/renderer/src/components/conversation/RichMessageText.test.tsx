import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { RichMessageText } from "./RichMessageText";

describe("RichMessageText tooltips", () => {
  it("associates a citation tooltip with its trigger and closes it with Escape", async () => {
    render(() => (
      <RichMessageText
        body="Read the source [1]."
        bots={[]}
        citations={[
          {
            number: 1,
            label: "Attention Is All You Need",
            url: "https://arxiv.org/abs/1706.03762",
            host: "arxiv.org",
          },
        ]}
        onSelectAgent={vi.fn()}
        onOpenLink={vi.fn()}
      />
    ));

    const citation = screen.getByRole("link", {
      name: "Open citation 1: Attention Is All You Need",
    });
    await fireEvent.focus(citation);
    const tooltip = await screen.findByRole("tooltip");
    expect(citation).toHaveAttribute("aria-describedby", tooltip.id);
    expect(tooltip).toHaveTextContent("Attention Is All You Need");

    await fireEvent.keyDown(citation, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
