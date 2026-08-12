// @vitest-environment node

import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MailboxStore } from "./mailbox-store";

let root: string;
let store: MailboxStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openbot-mailbox-test-"));
  store = new MailboxStore(join(root, "user-data"), join(root, "Shared"));
  await store.initialize();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("MailboxStore", () => {
  it("copies attachments once and fans out independent FIFO deliveries", async () => {
    const original = join(root, "report.csv");
    await writeFile(original, "account,value\nAcme,42\n");
    const drafts = await store.prepareAttachments([original]);
    const receipt = await store.enqueue({
      sender: { kind: "user" },
      recipientBotIds: ["chief", "sales-outbound"],
      text: "Review this data",
      draftIds: drafts.map((draft) => draft.id),
    });
    await rm(original);

    expect(receipt.deliveries).toHaveLength(2);
    expect(receipt.deliveries.map((item) => item.position)).toEqual([1, 1]);
    const first = store.getDelivery(receipt.deliveries[0].id);
    const second = store.getDelivery(receipt.deliveries[1].id);
    expect(first?.delivery.attachments[0]?.id).toBe(second?.delivery.attachments[0]?.id);
    await expect(access(first?.managedAttachments[0]?.path ?? "missing")).resolves.toBeUndefined();
  });

  it("persists cancellation, pause state, and idempotent agent sends", async () => {
    const first = await store.enqueue({
      sender: { kind: "bot", botId: "chief" },
      recipientBotIds: ["sales-outbound"],
      text: "Prepare a report",
      idempotencyKey: "thread:turn:call",
    });
    const duplicate = await store.enqueue({
      sender: { kind: "bot", botId: "chief" },
      recipientBotIds: ["sales-outbound"],
      text: "Prepare a report",
      idempotencyKey: "thread:turn:call",
    });
    expect(duplicate).toEqual(first);

    await store.cancel("sales-outbound", first.deliveries[0].id);
    await store.setPaused("sales-outbound", true);
    const restored = new MailboxStore(join(root, "user-data"), join(root, "Shared"));
    await restored.initialize();
    expect(restored.listQueue("sales-outbound")).toMatchObject({
      paused: true,
      deliveries: [{ status: "cancelled" }],
    });
  });

  it("fails closed instead of overwriting an unsupported mailbox state", async () => {
    const statePath = join(root, "user-data", "mailbox-state.json");
    const unsupported = '{"version":999,"messages":[{"important":true}]}\n';
    await writeFile(statePath, unsupported);

    const restored = new MailboxStore(join(root, "user-data"), join(root, "Shared"));
    await expect(restored.initialize()).rejects.toThrow("refusing to overwrite");
    await expect(readFile(statePath, "utf8")).resolves.toBe(unsupported);
  });

  it("persists reply metadata and one local reaction per conversation message", async () => {
    const receipt = await store.enqueue({
      sender: { kind: "user" },
      recipientBotIds: ["chief"],
      text: "Yes, continue",
      replyToMessageId: "assistant-1",
    });
    const deliveryId = receipt.deliveries[0].id;
    expect(store.conversationMessages("chief")[0]).toMatchObject({
      id: deliveryId,
      replyToMessageId: "assistant-1",
    });

    await store.setReaction("chief", "assistant-1", "❤️");
    const restored = new MailboxStore(join(root, "user-data"), join(root, "Shared"));
    await restored.initialize();
    expect(restored.reactionFor("chief", "assistant-1")).toBe("❤️");
    await restored.setReaction("chief", "assistant-1", null);
    expect(restored.reactionFor("chief", "assistant-1")).toBeNull();
  });

  it("tracks the initiating bot through a reply chain and detects explicit replies", async () => {
    const rootMessage = await store.enqueue({
      sender: { kind: "bot", botId: "researcher" },
      recipientBotIds: ["weather"],
      text: "Check tomorrow's weather.",
    });
    const weatherQuestion = await store.enqueue({
      sender: { kind: "bot", botId: "weather" },
      recipientBotIds: ["researcher"],
      text: "Which city?",
      replyToMessageId: rootMessage.messageId,
    });
    const locationReply = await store.enqueue({
      sender: { kind: "bot", botId: "researcher" },
      recipientBotIds: ["weather"],
      text: "Kraków.",
      replyToMessageId: weatherQuestion.messageId,
    });

    expect(store.chainOriginBotId(locationReply.messageId)).toBe("researcher");
    expect(store.hasReplyFrom("weather", locationReply.messageId)).toBe(false);
    await store.enqueue({
      sender: { kind: "bot", botId: "weather" },
      recipientBotIds: ["researcher"],
      text: "It will be sunny.",
      replyToMessageId: locationReply.messageId,
    });
    expect(store.hasReplyFrom("weather", locationReply.messageId)).toBe(true);
    await store.enqueue({
      sender: { kind: "bot", botId: "weather" },
      recipientBotIds: ["researcher"],
      text: "A second explicit update.",
      idempotencyKey: "thread-weather:turn-weather:call-1",
    });
    expect(store.hasBotMessageFromTurnTo("weather", "turn-weather", "researcher")).toBe(true);
    expect(store.hasBotMessageFromTurnTo("weather", "turn-weather", "other-agent")).toBe(false);
  });

  it("rejects directories and oversized recipient lists", async () => {
    const directory = join(root, "folder");
    await mkdir(directory);
    await expect(store.prepareAttachments([directory])).rejects.toThrow("regular files");
    await expect(
      store.enqueue({
        sender: { kind: "user" },
        recipientBotIds: Array.from({ length: 33 }, (_, index) => `bot-${index}`),
        text: "Too many",
      }),
    ).rejects.toThrow("32 recipients");
  });

  it("imports pathless image bytes and accepts an attachment-only user message", async () => {
    const [draft] = await store.prepareImportedAttachments(
      [],
      [
        {
          name: "clipboard.png",
          mimeType: "image/png",
          bytes: new Uint8Array([137, 80, 78, 71]),
        },
      ],
    );
    expect(draft).toMatchObject({
      kind: "image",
      mimeType: "image/png",
      previewKind: "image",
    });
    const receipt = await store.enqueue({
      sender: { kind: "user" },
      recipientBotIds: ["chief"],
      text: "",
      draftIds: [draft.id],
    });
    expect(store.getDelivery(receipt.deliveries[0].id)?.delivery).toMatchObject({
      text: "",
      attachments: [{ name: "clipboard.png" }],
    });
  });

  it("rejects managed attachments replaced by symlinks outside the transfer root", async () => {
    const source = join(root, "inside.txt");
    const outside = join(root, "outside.txt");
    await writeFile(source, "original");
    await writeFile(outside, "secret");
    const [draft] = await store.prepareAttachments([source]);
    const receipt = await store.enqueue({
      sender: { kind: "user" },
      recipientBotIds: ["chief"],
      text: "Review",
      draftIds: [draft.id],
    });
    const attachment = store.getDelivery(receipt.deliveries[0].id)?.managedAttachments[0];
    expect(attachment).toBeDefined();
    await rm(attachment?.path ?? "missing");
    await symlink(outside, attachment?.path ?? "missing");

    await expect(store.resolveAttachment(attachment?.id ?? "")).resolves.toBeNull();
  });

  it("keeps the persisted MIME type as the single source for attachment serving", async () => {
    const [draft] = await store.prepareImportedAttachments(
      [],
      [
        {
          name: "clipboard.bin",
          mimeType: "image/png",
          bytes: new Uint8Array([137, 80, 78, 71]),
        },
      ],
    );

    await expect(store.resolveAttachment(draft.id)).resolves.toMatchObject({
      mimeType: "image/png",
    });
  });

  it("reconstructs persistent outgoing and incoming exchanges with live delivery states", async () => {
    const receipt = await store.enqueue({
      sender: { kind: "bot", botId: "chief" },
      recipientBotIds: ["sales-outbound", "inbox-manager"],
      text: "Prepare your reports",
      replyToMessageId: "previous-message",
    });
    await store.markStarting(receipt.deliveries[0].id);
    await store.markRunning(receipt.deliveries[0].id, "turn-sales");

    const outgoing = store.conversationMessages("chief")[0];
    expect(outgoing).toMatchObject({
      id: `outbox-${receipt.messageId}`,
      exchange: {
        direction: "outgoing",
        recipientBotIds: ["sales-outbound", "inbox-manager"],
        replyToMessageId: "previous-message",
        deliveries: [{ status: "running" }, { status: "queued" }],
      },
    });
    expect(store.conversationMessages("sales-outbound")[0]).toMatchObject({
      author: "agent",
      senderBotId: "chief",
      exchange: { direction: "incoming" },
    });

    const restored = new MailboxStore(join(root, "user-data"), join(root, "Shared"));
    await restored.initialize();
    expect(restored.conversationMessages("chief")[0]?.exchange?.deliveries).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "running" })]),
    );
  });
});
