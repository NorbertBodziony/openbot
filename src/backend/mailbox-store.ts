import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";
import type {
  AttachmentDataInput,
  AttachmentKind,
  AttachmentPreviewKind,
  AttachmentSummary,
  ConversationMessage,
  DraftAttachment,
  MessageReaction,
  QueueDelivery,
  QueueDeliveryStatus,
  QueuedMessageReceipt,
  QueueSnapshot,
} from "../shared/ipc";
import { isMessageReaction } from "../shared/ipc";
import { isRecord } from "./protocol";

const MAX_ATTACHMENTS = 10;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_BYTES = 250 * 1024 * 1024;

interface StoredAttachment extends AttachmentSummary {
  path: string;
  sha256: string;
}

interface StoredDraft extends StoredAttachment {
  createdAt: string;
}

interface StoredMessage {
  id: string;
  sender: { kind: "user" } | { kind: "bot"; botId: string };
  text: string;
  attachments: StoredAttachment[];
  replyToMessageId: string | null;
  createdAt: string;
}

interface StoredDelivery {
  id: string;
  messageId: string;
  recipientBotId: string;
  status: QueueDeliveryStatus;
  turnId: string | null;
  error: string | null;
  createdAt: string;
}

interface StoredState {
  version: 1;
  messages: StoredMessage[];
  deliveries: StoredDelivery[];
  drafts: StoredDraft[];
  pausedBotIds: string[];
  idempotency: Record<string, string>;
  reactions: StoredReaction[];
}

interface StoredReaction {
  botId: string;
  messageId: string;
  emoji: MessageReaction;
  updatedAt: string;
}

interface EnqueueInput {
  sender: StoredMessage["sender"];
  recipientBotIds: string[];
  text: string;
  replyToMessageId?: string | null;
  draftIds?: string[];
  sourcePaths?: string[];
  idempotencyKey?: string;
}

export interface DeliveryContext {
  delivery: QueueDelivery;
  managedAttachments: Array<AttachmentSummary & { path: string }>;
}

const EMPTY_STATE: StoredState = {
  version: 1,
  messages: [],
  deliveries: [],
  drafts: [],
  pausedBotIds: [],
  idempotency: {},
  reactions: [],
};

export class MailboxStore {
  readonly #statePath: string;
  readonly #draftsRoot: string;
  readonly #transfersRoot: string;
  #state: StoredState = structuredClone(EMPTY_STATE);
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(userDataPath: string, sharedRoot: string) {
    this.#statePath = join(userDataPath, "mailbox.json");
    this.#draftsRoot = join(userDataPath, "attachment-drafts");
    this.#transfersRoot = join(sharedRoot, "Transfers");
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(dirname(this.#statePath), { recursive: true, mode: 0o700 }),
      mkdir(this.#draftsRoot, { recursive: true, mode: 0o700 }),
      mkdir(this.#transfersRoot, { recursive: true, mode: 0o700 }),
    ]);
    this.#state = await this.#readState();
  }

  async prepareAttachments(paths: string[]): Promise<DraftAttachment[]> {
    return this.prepareImportedAttachments(paths, []);
  }

  async prepareImportedAttachments(
    paths: string[],
    data: AttachmentDataInput[],
  ): Promise<DraftAttachment[]> {
    if (paths.length + data.length === 0) return [];
    if (paths.length + data.length > MAX_ATTACHMENTS) {
      throw new Error(`Choose at most ${MAX_ATTACHMENTS} files.`);
    }

    const prepared: StoredDraft[] = [];
    let total = 0;
    try {
      for (const sourcePath of paths) {
        const source = await inspectSource(sourcePath);
        total += source.size;
        if (total > MAX_TOTAL_BYTES) throw new Error("Attachments exceed the 250 MB total limit.");
        const id = randomUUID();
        const targetDirectory = join(this.#draftsRoot, id);
        const name = sanitizeName(source.path);
        const targetPath = join(targetDirectory, name);
        await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
        await copyFile(source.path, targetPath);
        const metadata = attachmentMetadata(name);
        prepared.push({
          id,
          name,
          size: source.size,
          ...metadata,
          previewUrl: attachmentPreviewUrl(id),
          path: targetPath,
          sha256: await sha256(source.path),
          createdAt: new Date().toISOString(),
        });
      }
      for (const item of data) {
        const bytes = normalizeBytes(item.bytes);
        if (bytes.byteLength > MAX_FILE_BYTES) {
          throw new Error(`${item.name} exceeds the 100 MB limit.`);
        }
        total += bytes.byteLength;
        if (total > MAX_TOTAL_BYTES) throw new Error("Attachments exceed the 250 MB total limit.");
        const id = randomUUID();
        const targetDirectory = join(this.#draftsRoot, id);
        const name = sanitizeName(item.name || "pasted-image.png");
        const targetPath = join(targetDirectory, name);
        const metadata = attachmentMetadata(name, item.mimeType);
        await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
        await writeFile(targetPath, bytes, { mode: 0o600 });
        prepared.push({
          id,
          name,
          size: bytes.byteLength,
          ...metadata,
          previewUrl: attachmentPreviewUrl(id),
          path: targetPath,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          createdAt: new Date().toISOString(),
        });
      }
      this.#state.drafts.push(...prepared);
      await this.#persist();
      return prepared.map(toAttachmentSummary);
    } catch (error) {
      const preparedIds = new Set(prepared.map((draft) => draft.id));
      this.#state.drafts = this.#state.drafts.filter((draft) => !preparedIds.has(draft.id));
      await Promise.all(
        prepared.map((draft) => rm(dirname(draft.path), { recursive: true, force: true })),
      );
      throw error;
    }
  }

  async discardDraft(id: string): Promise<void> {
    const index = this.#state.drafts.findIndex((draft) => draft.id === id);
    if (index < 0) return;
    const [draft] = this.#state.drafts.splice(index, 1);
    try {
      await this.#persist();
    } catch (error) {
      this.#state.drafts.splice(index, 0, draft);
      throw error;
    }
    await rm(dirname(draft.path), { recursive: true, force: true });
  }

  async enqueue(input: EnqueueInput): Promise<QueuedMessageReceipt> {
    if (input.idempotencyKey) {
      const existingMessageId = this.#state.idempotency[input.idempotencyKey];
      if (existingMessageId) return this.#receipt(existingMessageId);
    }

    const recipients = [...new Set(input.recipientBotIds)];
    if (recipients.length === 0) throw new Error("At least one recipient is required.");
    if (recipients.length > 32) throw new Error("A message can have at most 32 recipients.");

    const text = input.text.trim();
    if (text.length > 100_000) throw new Error("Message is too long.");

    const drafts = (input.draftIds ?? []).map((id) => {
      const draft = this.#state.drafts.find((candidate) => candidate.id === id);
      if (!draft) throw new Error(`Attachment draft no longer exists: ${id}`);
      return draft;
    });
    if (drafts.length !== new Set(input.draftIds ?? []).size) {
      throw new Error("Duplicate attachment draft.");
    }
    const sourcePaths = [...drafts.map((draft) => draft.path), ...(input.sourcePaths ?? [])];
    if (!text && sourcePaths.length === 0) throw new Error("Message cannot be empty.");
    if (sourcePaths.length > MAX_ATTACHMENTS) {
      throw new Error(`Attach at most ${MAX_ATTACHMENTS} files.`);
    }

    const messageId = randomUUID();
    const attachments = await this.#commitAttachments(messageId, sourcePaths);
    const createdAt = new Date().toISOString();
    const message: StoredMessage = {
      id: messageId,
      sender: input.sender,
      text,
      attachments,
      replyToMessageId: input.replyToMessageId ?? null,
      createdAt,
    };
    const deliveries = recipients.map<StoredDelivery>((recipientBotId) => ({
      id: randomUUID(),
      messageId,
      recipientBotId,
      status: "queued",
      turnId: null,
      error: null,
      createdAt,
    }));

    this.#state.messages.push(message);
    this.#state.deliveries.push(...deliveries);
    if (input.idempotencyKey) this.#state.idempotency[input.idempotencyKey] = messageId;
    this.#state.drafts = this.#state.drafts.filter(
      (draft) => !(input.draftIds ?? []).includes(draft.id),
    );
    try {
      await this.#persist();
    } catch (error) {
      const deliveryIds = new Set(deliveries.map((delivery) => delivery.id));
      this.#state.messages = this.#state.messages.filter((candidate) => candidate.id !== messageId);
      this.#state.deliveries = this.#state.deliveries.filter(
        (candidate) => !deliveryIds.has(candidate.id),
      );
      if (input.idempotencyKey && this.#state.idempotency[input.idempotencyKey] === messageId) {
        delete this.#state.idempotency[input.idempotencyKey];
      }
      for (const draft of drafts) {
        if (!this.#state.drafts.some((candidate) => candidate.id === draft.id)) {
          this.#state.drafts.push(draft);
        }
      }
      await rm(join(this.#transfersRoot, messageId), { recursive: true, force: true });
      throw error;
    }
    await Promise.all(
      drafts.map((draft) => rm(dirname(draft.path), { recursive: true, force: true })),
    );
    return this.#receipt(messageId);
  }

  listQueue(botId: string): QueueSnapshot {
    const positions = this.#queuedPositions();
    return {
      botId,
      paused: this.#state.pausedBotIds.includes(botId),
      deliveries: this.#state.deliveries
        .filter((delivery) => delivery.recipientBotId === botId)
        .map((delivery) => this.#publicDelivery(delivery, positions)),
    };
  }

  conversationMessages(botId: string): ConversationMessage[] {
    const messages: ConversationMessage[] = [];
    const deliveriesByMessage = new Map<string, StoredDelivery[]>();
    const positions = this.#queuedPositions();
    for (const delivery of this.#state.deliveries) {
      const deliveries = deliveriesByMessage.get(delivery.messageId) ?? [];
      deliveries.push(delivery);
      deliveriesByMessage.set(delivery.messageId, deliveries);
    }
    for (const message of this.#state.messages) {
      const deliveries = deliveriesByMessage.get(message.id) ?? [];
      if (message.sender.kind === "bot" && message.sender.botId === botId) {
        messages.push({
          id: `outbox-${message.id}`,
          turnId: this.#sourceTurnId(message.id),
          author: "system",
          source: "system",
          text: message.text,
          attachments: message.attachments.map(toAttachmentSummary),
          replyToMessageId: message.replyToMessageId,
          exchange: {
            direction: "outgoing",
            messageId: message.id,
            senderBotId: botId,
            recipientBotIds: deliveries.map((item) => item.recipientBotId),
            replyToMessageId: message.replyToMessageId,
            deliveries: deliveries.map((item) => {
              const delivery = this.#publicDelivery(item, positions);
              return {
                id: delivery.id,
                recipientBotId: delivery.recipientBotId,
                status: delivery.status,
                position: delivery.position,
                error: delivery.error,
              };
            }),
          },
          createdAt: message.createdAt,
          status: "completed",
          itemType: "agent-exchange",
        });
      }

      for (const storedDelivery of deliveries) {
        if (storedDelivery.recipientBotId !== botId) continue;
        const delivery = this.#publicDelivery(storedDelivery, positions);
        messages.push({
          id: delivery.id,
          turnId: storedDelivery.turnId ?? undefined,
          author: message.sender.kind === "bot" ? "agent" : "user",
          source: message.sender.kind === "bot" ? "agent" : "user",
          text: message.text,
          senderBotId: message.sender.kind === "bot" ? message.sender.botId : undefined,
          attachments: message.attachments.map(toAttachmentSummary),
          replyToMessageId: message.replyToMessageId,
          delivery: {
            id: delivery.id,
            status: delivery.status,
            position: delivery.position,
          },
          exchange:
            message.sender.kind === "bot"
              ? {
                  direction: "incoming",
                  messageId: message.id,
                  senderBotId: message.sender.botId,
                  recipientBotIds: deliveries.map((item) => item.recipientBotId),
                  replyToMessageId: message.replyToMessageId,
                  deliveries: deliveries.map((item) => {
                    const publicItem = this.#publicDelivery(item, positions);
                    return {
                      id: publicItem.id,
                      recipientBotId: publicItem.recipientBotId,
                      status: publicItem.status,
                      position: publicItem.position,
                      error: publicItem.error,
                    };
                  }),
                }
              : undefined,
          createdAt: message.createdAt,
          status: delivery.status === "failed" ? "failed" : "completed",
          itemType: message.sender.kind === "bot" ? "agent-exchange" : undefined,
        });
      }
    }
    return messages;
  }

  reactionFor(botId: string, messageId: string): MessageReaction | null {
    return (
      this.#state.reactions.find(
        (reaction) => reaction.botId === botId && reaction.messageId === messageId,
      )?.emoji ?? null
    );
  }

  reactionsFor(botId: string): Map<string, MessageReaction> {
    return new Map(
      this.#state.reactions
        .filter((reaction) => reaction.botId === botId)
        .map((reaction) => [reaction.messageId, reaction.emoji]),
    );
  }

  async setReaction(
    botId: string,
    messageId: string,
    emoji: MessageReaction | null,
  ): Promise<void> {
    const index = this.#state.reactions.findIndex(
      (reaction) => reaction.botId === botId && reaction.messageId === messageId,
    );
    if (emoji === null) {
      if (index < 0) return;
      this.#state.reactions.splice(index, 1);
    } else if (index >= 0) {
      this.#state.reactions[index] = {
        botId,
        messageId,
        emoji,
        updatedAt: new Date().toISOString(),
      };
    } else {
      this.#state.reactions.push({
        botId,
        messageId,
        emoji,
        updatedAt: new Date().toISOString(),
      });
    }
    await this.#persist();
  }

  #sourceTurnId(messageId: string): string | undefined {
    const key = Object.entries(this.#state.idempotency).find(
      ([, value]) => value === messageId,
    )?.[0];
    if (!key) return undefined;
    const parts = key.split(":");
    return parts.length >= 3 ? parts.at(-2) : undefined;
  }

  senderBotIdsForRecipient(botId: string): string[] {
    const result = new Set<string>();
    for (const delivery of this.#state.deliveries) {
      if (delivery.recipientBotId !== botId) continue;
      const sender = this.#requireMessage(delivery.messageId).sender;
      if (sender.kind === "bot") result.add(sender.botId);
    }
    return [...result];
  }

  nextQueued(botId: string): DeliveryContext | null {
    if (this.#state.pausedBotIds.includes(botId)) return null;
    if (
      this.#state.deliveries.some(
        (delivery) =>
          delivery.recipientBotId === botId &&
          (delivery.status === "starting" || delivery.status === "running"),
      )
    ) {
      return null;
    }
    const delivery = this.#state.deliveries.find(
      (candidate) => candidate.recipientBotId === botId && candidate.status === "queued",
    );
    return delivery ? this.#context(delivery) : null;
  }

  getDelivery(deliveryId: string): DeliveryContext | null {
    const delivery = this.#state.deliveries.find((candidate) => candidate.id === deliveryId);
    return delivery ? this.#context(delivery) : null;
  }

  findDeliveryByTurn(turnId: string): DeliveryContext | null {
    const delivery = this.#state.deliveries.find((candidate) => candidate.turnId === turnId);
    return delivery ? this.#context(delivery) : null;
  }

  chainOriginBotId(messageId: string): string | null {
    const visited = new Set<string>();
    let message = this.#state.messages.find((candidate) => candidate.id === messageId);
    while (message && !visited.has(message.id)) {
      visited.add(message.id);
      const parent = message.replyToMessageId
        ? this.#state.messages.find((candidate) => candidate.id === message?.replyToMessageId)
        : undefined;
      if (!parent) return message.sender.kind === "bot" ? message.sender.botId : null;
      message = parent;
    }
    return null;
  }

  hasReplyFrom(botId: string, messageId: string): boolean {
    return this.#state.messages.some(
      (message) =>
        message.sender.kind === "bot" &&
        message.sender.botId === botId &&
        message.replyToMessageId === messageId,
    );
  }

  hasBotMessageFromTurnTo(botId: string, turnId: string, recipientBotId: string): boolean {
    return this.#state.messages.some((message) => {
      if (message.sender.kind !== "bot" || message.sender.botId !== botId) return false;
      if (this.#sourceTurnId(message.id) !== turnId) return false;
      return this.#state.deliveries.some(
        (delivery) =>
          delivery.messageId === message.id && delivery.recipientBotId === recipientBotId,
      );
    });
  }

  async markStarting(deliveryId: string): Promise<void> {
    await this.#updateDelivery(deliveryId, ["queued"], { status: "starting", error: null });
  }

  async markRunning(deliveryId: string, turnId: string): Promise<void> {
    await this.#updateDelivery(deliveryId, ["starting", "running"], {
      status: "running",
      turnId,
      error: null,
    });
  }

  async markTerminal(
    deliveryId: string,
    status: Extract<QueueDeliveryStatus, "completed" | "failed" | "interrupted">,
    error: string | null = null,
  ): Promise<void> {
    await this.#updateDelivery(deliveryId, ["starting", "running"], { status, error });
  }

  async cancel(botId: string, deliveryId: string): Promise<void> {
    const delivery = this.#state.deliveries.find(
      (candidate) => candidate.id === deliveryId && candidate.recipientBotId === botId,
    );
    if (!delivery) throw new Error("Queued message was not found.");
    if (delivery.status !== "queued") throw new Error("Only queued messages can be cancelled.");
    delivery.status = "cancelled";
    await this.#persist();
  }

  async setPaused(botId: string, paused: boolean): Promise<void> {
    const current = new Set(this.#state.pausedBotIds);
    if (paused) current.add(botId);
    else current.delete(botId);
    this.#state.pausedBotIds = [...current];
    await this.#persist();
  }

  unresolvedDeliveries(): DeliveryContext[] {
    return this.#state.deliveries
      .filter((delivery) => delivery.status === "starting" || delivery.status === "running")
      .map((delivery) => this.#context(delivery));
  }

  async recoverAsInterrupted(deliveryId: string, reason: string): Promise<void> {
    await this.#updateDelivery(deliveryId, ["starting", "running"], {
      status: "interrupted",
      error: reason,
    });
  }

  async resolveAttachment(id: string): Promise<{ path: string; mimeType: string } | null> {
    const draft = this.#state.drafts.find((candidate) => candidate.id === id);
    if (draft) return resolveManagedAttachment(this.#draftsRoot, draft);
    for (const message of this.#state.messages) {
      const attachment = message.attachments.find((candidate) => candidate.id === id);
      if (attachment) return resolveManagedAttachment(this.#transfersRoot, attachment);
    }
    return null;
  }

  #context(delivery: StoredDelivery): DeliveryContext {
    const message = this.#requireMessage(delivery.messageId);
    return {
      delivery: this.#publicDelivery(delivery),
      managedAttachments: message.attachments.map((attachment) => ({
        ...toAttachmentSummary(attachment),
        path: attachment.path,
      })),
    };
  }

  #publicDelivery(delivery: StoredDelivery, positions = this.#queuedPositions()): QueueDelivery {
    const message = this.#requireMessage(delivery.messageId);
    return {
      ...delivery,
      sender: structuredClone(message.sender),
      text: message.text,
      attachments: message.attachments.map(toAttachmentSummary),
      replyToMessageId: message.replyToMessageId,
      position: delivery.status === "queued" ? (positions.get(delivery.id) ?? null) : null,
    };
  }

  #queuedPositions(): Map<string, number> {
    const counts = new Map<string, number>();
    const positions = new Map<string, number>();
    for (const delivery of this.#state.deliveries) {
      if (delivery.status !== "queued") continue;
      const position = (counts.get(delivery.recipientBotId) ?? 0) + 1;
      counts.set(delivery.recipientBotId, position);
      positions.set(delivery.id, position);
    }
    return positions;
  }

  #receipt(messageId: string): QueuedMessageReceipt {
    const positions = this.#queuedPositions();
    return {
      messageId,
      deliveries: this.#state.deliveries
        .filter((delivery) => delivery.messageId === messageId)
        .map((delivery) => {
          const item = this.#publicDelivery(delivery, positions);
          return {
            id: item.id,
            recipientBotId: item.recipientBotId,
            status: item.status,
            position: item.position,
          };
        }),
    };
  }

  async #commitAttachments(messageId: string, sourcePaths: string[]): Promise<StoredAttachment[]> {
    if (sourcePaths.length === 0) return [];
    const inspected = await Promise.all(sourcePaths.map(inspectSource));
    const total = inspected.reduce((sum, source) => sum + source.size, 0);
    if (total > MAX_TOTAL_BYTES) throw new Error("Attachments exceed the 250 MB total limit.");

    const temporaryRoot = join(this.#transfersRoot, `.tmp-${messageId}`);
    const finalRoot = join(this.#transfersRoot, messageId);
    await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
    const usedNames = new Set<string>();
    try {
      const attachments: StoredAttachment[] = [];
      for (const source of inspected) {
        const name = uniqueName(sanitizeName(source.path), usedNames);
        const id = randomUUID();
        await copyFile(source.path, join(temporaryRoot, name));
        const metadata = attachmentMetadata(name);
        attachments.push({
          id,
          name,
          size: source.size,
          ...metadata,
          previewUrl: attachmentPreviewUrl(id),
          path: join(finalRoot, name),
          sha256: await sha256(source.path),
        });
      }
      await rename(temporaryRoot, finalRoot);
      return attachments;
    } catch (error) {
      await rm(temporaryRoot, { recursive: true, force: true });
      throw error;
    }
  }

  async #updateDelivery(
    id: string,
    allowed: QueueDeliveryStatus[],
    patch: Partial<StoredDelivery>,
  ): Promise<void> {
    const delivery = this.#state.deliveries.find((candidate) => candidate.id === id);
    if (!delivery) throw new Error(`Unknown delivery: ${id}`);
    if (!allowed.includes(delivery.status)) return;
    Object.assign(delivery, patch);
    await this.#persist();
  }

  #requireMessage(id: string): StoredMessage {
    const message = this.#state.messages.find((candidate) => candidate.id === id);
    if (!message) throw new Error(`Mailbox message is missing: ${id}`);
    return message;
  }

  async #readState(): Promise<StoredState> {
    try {
      const value: unknown = JSON.parse(await readFile(this.#statePath, "utf8"));
      if (!isStoredState(value)) {
        throw new Error(
          "Mailbox state is corrupt or from a newer OpenBot version; refusing to overwrite it.",
        );
      }
      return value;
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return structuredClone(EMPTY_STATE);
      throw error;
    }
  }

  async #persist(): Promise<void> {
    const serialized = `${JSON.stringify(this.#state, null, 2)}\n`;
    const temporaryPath = `${this.#statePath}.${process.pid}.${randomUUID()}.tmp`;
    this.#writeQueue = this.#writeQueue
      .catch(() => undefined)
      .then(async () => {
        await writeFile(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
        await rename(temporaryPath, this.#statePath);
      });
    await this.#writeQueue;
  }
}

async function resolveManagedAttachment(
  root: string,
  attachment: StoredAttachment,
): Promise<{ path: string; mimeType: string } | null> {
  try {
    const [canonicalRoot, canonicalPath] = await Promise.all([
      realpath(root),
      realpath(attachment.path),
    ]);
    if (!isWithin(canonicalRoot, canonicalPath)) return null;
    if (!(await stat(canonicalPath)).isFile()) return null;
    return { path: canonicalPath, mimeType: attachment.mimeType };
  } catch {
    return null;
  }
}

async function inspectSource(sourcePath: string): Promise<{ path: string; size: number }> {
  const path = await realpath(sourcePath);
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`Only regular files can be attached: ${basename(path)}`);
  if (metadata.size > MAX_FILE_BYTES)
    throw new Error(`${basename(path)} exceeds the 100 MB limit.`);
  return { path, size: metadata.size };
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function sanitizeName(path: string): string {
  const value = basename(path)
    .replace(/[^\p{L}\p{N}._ -]+/gu, "-")
    .replace(/^\.+/, "")
    .trim();
  return value.slice(0, 180) || "attachment";
}

function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const extension = extname(name);
  const stem = name.slice(0, -extension.length || undefined);
  let index = 2;
  while (used.has(`${stem}-${index}${extension}`)) index += 1;
  const result = `${stem}-${index}${extension}`;
  used.add(result);
  return result;
}

function attachmentMetadata(
  name: string,
  explicitMimeType?: string,
): { kind: AttachmentKind; mimeType: string; previewKind: AttachmentPreviewKind } {
  const extension = extname(name).toLowerCase();
  const inferred =
    extension === ".png"
      ? "image/png"
      : extension === ".jpg" || extension === ".jpeg"
        ? "image/jpeg"
        : extension === ".gif"
          ? "image/gif"
          : extension === ".webp"
            ? "image/webp"
            : extension === ".avif"
              ? "image/avif"
              : extension === ".pdf"
                ? "application/pdf"
                : /\.(txt|md|markdown|csv|json|log|xml|ya?ml|tsx?|jsx?|css|html?)$/i.test(name)
                  ? "text/plain"
                  : "application/octet-stream";
  const mimeType = explicitMimeType?.trim() || inferred;
  const previewKind: AttachmentPreviewKind = mimeType.startsWith("image/")
    ? "image"
    : mimeType === "application/pdf"
      ? "pdf"
      : mimeType.startsWith("text/") || mimeType === "application/json"
        ? "text"
        : "none";
  return { kind: previewKind === "image" ? "image" : "file", mimeType, previewKind };
}

function attachmentPreviewUrl(id: string): string {
  return `openbot-attachment://file/${id}`;
}

function toAttachmentSummary(attachment: StoredAttachment): AttachmentSummary {
  const metadata = attachmentMetadata(attachment.name, attachment.mimeType);
  return {
    id: attachment.id,
    name: attachment.name,
    size: attachment.size,
    ...metadata,
    previewUrl: attachment.previewUrl,
  };
}

function normalizeBytes(value: Uint8Array): Uint8Array {
  if (value instanceof Uint8Array) return value;
  throw new Error("Attachment data is invalid.");
}

function isStoredState(value: unknown): value is StoredState {
  return (
    isRecord(value) &&
    value.version === 1 &&
    Array.isArray(value.messages) &&
    value.messages.every(isStoredMessage) &&
    Array.isArray(value.deliveries) &&
    value.deliveries.every(isStoredDelivery) &&
    Array.isArray(value.drafts) &&
    value.drafts.every(isStoredDraft) &&
    Array.isArray(value.pausedBotIds) &&
    value.pausedBotIds.every((item) => typeof item === "string") &&
    isRecord(value.idempotency) &&
    Object.values(value.idempotency).every((item) => typeof item === "string") &&
    Array.isArray(value.reactions) &&
    value.reactions.every(isStoredReaction)
  );
}

function isStoredAttachment(value: unknown): value is StoredAttachment {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.size === "number" &&
    (value.kind === "image" || value.kind === "file") &&
    typeof value.mimeType === "string" &&
    (value.previewKind === "image" ||
      value.previewKind === "pdf" ||
      value.previewKind === "text" ||
      value.previewKind === "none") &&
    (typeof value.previewUrl === "string" || value.previewUrl === undefined) &&
    typeof value.path === "string" &&
    typeof value.sha256 === "string"
  );
}

function isStoredDraft(value: unknown): value is StoredDraft {
  return (
    isStoredAttachment(value) &&
    typeof (value as StoredAttachment & { createdAt?: unknown }).createdAt === "string"
  );
}

function isStoredMessage(value: unknown): value is StoredMessage {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isRecord(value.sender) &&
    (value.sender.kind === "user" ||
      (value.sender.kind === "bot" && typeof value.sender.botId === "string")) &&
    typeof value.text === "string" &&
    Array.isArray(value.attachments) &&
    value.attachments.every(isStoredAttachment) &&
    (typeof value.replyToMessageId === "string" || value.replyToMessageId === null) &&
    typeof value.createdAt === "string"
  );
}

function isStoredDelivery(value: unknown): value is StoredDelivery {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.messageId === "string" &&
    typeof value.recipientBotId === "string" &&
    (value.status === "queued" ||
      value.status === "starting" ||
      value.status === "running" ||
      value.status === "completed" ||
      value.status === "failed" ||
      value.status === "interrupted" ||
      value.status === "cancelled") &&
    (typeof value.turnId === "string" || value.turnId === null) &&
    (typeof value.error === "string" || value.error === null) &&
    typeof value.createdAt === "string"
  );
}

function isStoredReaction(value: unknown): value is StoredReaction {
  return (
    isRecord(value) &&
    typeof value.botId === "string" &&
    typeof value.messageId === "string" &&
    isMessageReaction(value.emoji) &&
    typeof value.updatedAt === "string"
  );
}

function isWithin(root: string, path: string): boolean {
  const candidate = relative(root, path);
  return candidate !== "" && !candidate.startsWith("..") && !isAbsolute(candidate);
}
