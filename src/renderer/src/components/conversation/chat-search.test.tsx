import { describe, expect, it } from "vitest";
import { findChatSearchMatches } from "./chat-search";

describe("conversation search", () => {
  it("finds every visible occurrence, including text split by formatting", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <article data-chat-search-message="first">
        <p>Launch <strong>milestone</strong> and milestones.</p>
        <span aria-hidden="true">milestone</span>
      </article>
      <article data-chat-search-message="second"><p>No match here.</p></article>
    `;

    const matches = findChatSearchMatches(root, "milestone");

    expect(matches).toHaveLength(2);
    expect(matches.map((match) => match.range.toString())).toEqual(["milestone", "milestone"]);
    expect(matches.every((match) => match.message.dataset.chatSearchMessage === "first")).toBe(true);
  });

  it("matches a phrase across adjacent inline elements", () => {
    const root = document.createElement("div");
    root.innerHTML = `<article data-chat-search-message="formatted"><p>Launch <strong>milestone</strong></p></article>`;

    const matches = findChatSearchMatches(root, "launch milestone");

    expect(matches).toHaveLength(1);
    expect(matches[0]?.range.toString()).toBe("Launch milestone");
  });
});
