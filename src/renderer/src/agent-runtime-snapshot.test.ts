import type { AgentApproval, AgentRuntimeApproval, AgentRuntimeSnapshot } from "@openbot/contracts/ipc";
import {
  appendLatestRuntimeMessages,
  type PendingAttentionPrompts,
  reconcileAttentionApprovals,
  reconcileAttentionPrompts,
} from "./agent-runtime-snapshot";
import { promptRequestKey } from "./conversation-keys";
import type { BotMessage } from "./data";

const prompt = (
  botId: string,
  requestId: string,
  turnId = "turn-1",
): AgentRuntimeSnapshot["pendingPrompts"][number] => ({
  requestId,
  botId,
  threadId: `thread-${botId}`,
  turnId,
  questions: [{ id: "q", header: "Header", question: "Question?", isSecret: false, options: null }],
});

const approval = (botId: string, requestId: string): AgentRuntimeApproval => ({
  requestId,
  botId,
  threadId: `thread-${botId}`,
  turnId: "turn-1",
  kind: "command",
  command: "ls",
  cwd: null,
  reason: null,
  grantRoot: null,
  permissions: null,
  truncated: false,
});

const takeover = (botId: string, requestId: string) => ({
  requestId,
  botId,
  threadId: `thread-${botId}`,
  turnId: "turn-1",
  tabId: "tab-1",
});

// `?? ""` keeps the failure pointing the right way: an empty string matches no
// prompt, so a `promptRequestKey` that stopped producing one would turn the
// test below red rather than passing it for the wrong reason.
const answeredKey = (turnId: string, requestId: string) => promptRequestKey(turnId, requestId) ?? "";

const attention = (
  overrides: Partial<Pick<AgentRuntimeSnapshot, "attentionComplete" | "pendingPrompts" | "pendingBrowserTakeovers">>,
) => ({
  attentionComplete: true,
  pendingPrompts: [],
  pendingBrowserTakeovers: [],
  ...overrides,
});

describe("reconcileAttentionPrompts", () => {
  it("shows the prompts a complete snapshot lists", () => {
    const next = reconcileAttentionPrompts({}, attention({ pendingPrompts: [prompt("chief", "r1")] }), {});

    expect(next.chief).toMatchObject({ type: "prompt", requestId: "r1" });
  });

  it("drops a prompt a complete snapshot no longer lists", () => {
    const current: PendingAttentionPrompts = { chief: { type: "prompt", ...prompt("chief", "r1") } };

    expect(reconcileAttentionPrompts(current, attention({}), {}).chief).toBeUndefined();
  });

  it("keeps a prompt an incomplete snapshot omits", () => {
    const current: PendingAttentionPrompts = { chief: { type: "prompt", ...prompt("chief", "r1") } };

    const next = reconcileAttentionPrompts(current, attention({ attentionComplete: false }), {});

    expect(next.chief).toMatchObject({ requestId: "r1" });
  });

  it("does not bring back a prompt whose answer is already on its way", () => {
    const next = reconcileAttentionPrompts({}, attention({ pendingPrompts: [prompt("chief", "r1", "turn-7")] }), {
      chief: answeredKey("turn-7", "r1"),
    });

    expect(next.chief).toBeUndefined();
  });

  it("still shows a later prompt from the same agent", () => {
    const next = reconcileAttentionPrompts({}, attention({ pendingPrompts: [prompt("chief", "r2", "turn-7")] }), {
      chief: answeredKey("turn-7", "r1"),
    });

    expect(next.chief).toMatchObject({ requestId: "r2" });
  });

  it("puts a browser takeover in front of a prompt for the same agent", () => {
    const next = reconcileAttentionPrompts(
      {},
      attention({ pendingPrompts: [prompt("chief", "r1")], pendingBrowserTakeovers: [takeover("chief", "r9")] }),
      {},
    );

    expect(next.chief).toMatchObject({ type: "browser-takeover-requested", request: { requestId: "r9" } });
  });

  it("leaves the agents an incomplete snapshot says nothing about", () => {
    const next = reconcileAttentionPrompts(
      { scout: { type: "prompt", ...prompt("scout", "r1") } },
      attention({ attentionComplete: false, pendingPrompts: [prompt("chief", "r2")] }),
      {},
    );

    expect(Object.keys(next).sort()).toEqual(["chief", "scout"]);
  });
});

describe("reconcileAttentionApprovals", () => {
  it("shows the approvals a complete snapshot lists", () => {
    const next = reconcileAttentionApprovals(
      {},
      { attentionComplete: true, pendingApprovals: [approval("chief", "a1")] },
    );

    expect(next.chief).toMatchObject({ requestId: "a1" });
  });

  it("drops an approval a complete snapshot no longer lists", () => {
    const current: Record<string, AgentApproval | undefined> = { chief: approval("chief", "a1") };

    expect(
      reconcileAttentionApprovals(current, { attentionComplete: true, pendingApprovals: [] }).chief,
    ).toBeUndefined();
  });

  it("keeps an approval an incomplete snapshot omits", () => {
    const current: Record<string, AgentApproval | undefined> = { chief: approval("chief", "a1") };

    const next = reconcileAttentionApprovals(current, { attentionComplete: false, pendingApprovals: [] });

    expect(next.chief).toMatchObject({ requestId: "a1" });
  });

  it("replaces an approval the snapshot describes differently", () => {
    const current: Record<string, AgentApproval | undefined> = { chief: approval("chief", "a1") };

    const next = reconcileAttentionApprovals(current, {
      attentionComplete: false,
      pendingApprovals: [approval("chief", "a2")],
    });

    expect(next.chief).toMatchObject({ requestId: "a2" });
  });
});

describe("appendLatestRuntimeMessages", () => {
  const snapshotMessage = (botId: string, id: string, text: string) => ({
    botId,
    id,
    text,
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  it("appends a message the transcript has not seen", () => {
    const next = appendLatestRuntimeMessages({}, [snapshotMessage("chief", "m1", "Done")]);

    expect(next.chief).toEqual([
      {
        id: "m1",
        author: "bot",
        body: "Done",
        time: "2026-01-01T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });

  it("leaves a message the transcript already holds", () => {
    const current: Record<string, BotMessage[]> = {
      chief: [{ id: "m1", author: "bot", body: "The full answer", time: "t" }],
    };

    const next = appendLatestRuntimeMessages(current, [snapshotMessage("chief", "m1", "The full")]);

    expect(next.chief).toEqual([{ id: "m1", author: "bot", body: "The full answer", time: "t" }]);
  });

  it("keeps the messages before the one it appends", () => {
    const current: Record<string, BotMessage[]> = {
      chief: [{ id: "m1", author: "you", body: "Go", time: "t" }],
    };

    const next = appendLatestRuntimeMessages(current, [snapshotMessage("chief", "m2", "Going")]);

    expect(next.chief?.map((message) => message.id)).toEqual(["m1", "m2"]);
  });

  it("cleans the message text the snapshot carries", () => {
    const citation = `${String.fromCodePoint(0xe200)}cite${String.fromCodePoint(0xe201)}`;

    const next = appendLatestRuntimeMessages({}, [snapshotMessage("chief", "m1", `See ${citation}here`)]);

    expect(next.chief?.[0]?.body).toBe("See here");
  });

  it("appends for each agent the snapshot mentions", () => {
    const next = appendLatestRuntimeMessages({}, [
      snapshotMessage("chief", "m1", "One"),
      snapshotMessage("scout", "m2", "Two"),
    ]);

    expect(Object.keys(next).sort()).toEqual(["chief", "scout"]);
  });
});
