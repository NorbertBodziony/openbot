import type { BrowserTab } from "@openbot/contracts/ipc";
import { activeTabAfterLoad, browserTabsAfterClose } from "./browser-tab-reconciliation";

const tab = (id: string): BrowserTab => ({
  id,
  title: `Tab ${id}`,
  url: `https://example.test/${id}`,
  loading: false,
  ownerThreadId: null,
  ownerAgentId: null,
});

describe("activeTabAfterLoad", () => {
  it("shows the tab main named", () => {
    expect(activeTabAfterLoad({ tabs: [tab("a"), tab("b")], activeTabId: "b" })).toBe("b");
  });

  it("shows the first tab when main named none", () => {
    expect(activeTabAfterLoad({ tabs: [tab("a"), tab("b")], activeTabId: null })).toBe("a");
  });

  it("shows nothing when the workspace has no tabs", () => {
    expect(activeTabAfterLoad({ tabs: [], activeTabId: null })).toBeNull();
  });
});

describe("browserTabsAfterClose", () => {
  it("leaves the front tab alone when another one closes", () => {
    const result = browserTabsAfterClose([tab("a"), tab("b"), tab("c")], "a", "b");

    expect(result.tabs.map((entry) => entry.id)).toEqual(["b", "c"]);
    expect(result.activeTabId).toBe("b");
  });

  it("moves to the tab that took the closed one's place", () => {
    const result = browserTabsAfterClose([tab("a"), tab("b"), tab("c")], "b", "b");

    expect(result.tabs.map((entry) => entry.id)).toEqual(["a", "c"]);
    expect(result.activeTabId).toBe("c");
  });

  it("moves back one when the closed tab was last", () => {
    const result = browserTabsAfterClose([tab("a"), tab("b"), tab("c")], "c", "c");

    expect(result.activeTabId).toBe("b");
  });

  it("has nothing in front once the last tab closes", () => {
    const result = browserTabsAfterClose([tab("a")], "a", "a");

    expect(result.tabs).toEqual([]);
    expect(result.activeTabId).toBeNull();
  });

  it("leaves a list that never held the closed tab as it was", () => {
    const result = browserTabsAfterClose([tab("a"), tab("b")], "gone", "a");

    expect(result.tabs.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(result.activeTabId).toBe("a");
  });
});
