import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";
import { rewriteAttachmentReferences } from "@openbot/contracts/attachment-references";
import { ATTACHMENT_LIMITS, INPUT_LIMITS } from "@openbot/contracts/input-limits";
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
} from "@openbot/contracts/ipc";
import { isMessageReaction } from "@openbot/contracts/ipc";
import { isNumber, isString } from "@openbot/contracts/runtime-values";
import { OpenBotDatabase } from "./openbot-database";
import { isRecord } from "./protocol";

const MAX_ATTACHMENTS = INPUT_LIMITS.attachments;
const MAX_FILE_BYTES = ATTACHMENT_LIMITS.fileBytes;
const MAX_TOTAL_BYTES = ATTACHMENT_LIMITS.totalBytes;
const TRANSFER_MANIFEST_FILE = ".openbot-transfer.json";

interface StoredAttachment extends AttachmentSummary {
  path: string;
  sha256: string;
}

interface StoredGeneratedAttachment extends StoredAttachment {
  ownerBotId?: string;
  ownerThreadId?: string | null;
}

interface StoredDraft extends StoredAttachment {
  createdAt: string;
}

interface StoredMessage {
  id: string;
  sender:
    | { kind: "user" }
    | { kind: "bot"; botId: string }
    | { kind: "routine"; routineId: string; runId: string; routineName: string; scheduledFor: string };
  text: string;
  attachments: StoredAttachment[];
  replyToMessageId: string | null;
  createdAt: string;
}

interface StoredDelivery {
  id: string;
  messageId: string;
  recipientBotId: string;
  queueOrder: number;
  status: QueueDeliveryStatus;
  turnId: string | null;
  error: string | null;
  createdAt: string;
}

interface StoredState {
  version: 3;
  messages: StoredMessage[];
  deliveries: StoredDelivery[];
  drafts: StoredDraft[];
  generatedAttachments: StoredGeneratedAttachment[];
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

interface TransferManifest {
  version: 1;
  kind: "message-transfer" | "generated-attachment";
  transferId?: string;
  messageId?: string;
  generatedAttachmentId?: string;
  sender?: StoredMessage["sender"];
  recipientBotIds?: string[];
  ownerBotId?: string;
  ownerThreadId?: string | null;
  createdAt: string;
  attachments: Array<{
    id: string;
    name: string;
    relativePath: string;
    size: number;
    kind: AttachmentKind;
    mimeType: string;
    previewKind: AttachmentPreviewKind;
    sha256: string;
  }>;
}

export interface DeliveryContext {
  delivery: QueueDelivery;
  managedAttachments: Array<AttachmentSummary & { path: string }>;
}

export interface ExportedAttachmentFile {
  sourcePath: string;
  relativePath: string;
}

const EMPTY_STATE: StoredState = {
  version: 3,
  messages: [],
  deliveries: [],
  drafts: [],
  generatedAttachments: [],
  pausedBotIds: [],
  idempotency: {},
  reactions: [],
};

export class MailboxStore {
  readonly #statePath: string;
  readonly #draftsRoot: string;
  readonly #transfersRoot: string;
  readonly #database: OpenBotDatabase;
  #state: StoredState = structuredClone(EMPTY_STATE);

  constructor(userDataPath: string, sharedRoot: string, database = new OpenBotDatabase(userDataPath)) {
    this.#statePath = join(userDataPath, "mailbox.json");
    this.#draftsRoot = join(userDataPath, "attachment-drafts");
    this.#transfersRoot = join(sharedRoot, "Transfers");
    this.#database = database;
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(dirname(this.#statePath), { recursive: true, mode: 0o700 }),
      mkdir(this.#draftsRoot, { recursive: true, mode: 0o700 }),
      mkdir(this.#transfersRoot, { recursive: true, mode: 0o700 }),
    ]);
    await this.#database.initialize();
    const persisted = this.#database.readMailboxState();
    if (persisted) {
      if (!isStoredState(persisted)) throw new Error("Stored mailbox projection is invalid.");
      this.#state = normalizeStoredState(persisted);
    } else {
      this.#state = normalizeStoredState(await this.#readState());
      await this.#database.backupLegacyFile(this.#statePath);
      await this.#persist("mailbox.legacy-imported", "legacy-import:mailbox:v1");
    }
    if (this.#state.drafts.length > 0) {
      this.#state.drafts = [];
      await this.#persist("mailbox.drafts-cleared");
    }
    await rm(this.#draftsRoot, { recursive: true, force: true });
    await mkdir(this.#draftsRoot, { recursive: true, mode: 0o700 });
    await this.#drainFileDeletionOutbox();
  }

  async prepareAttachments(paths: string[]): Promise<DraftAttachment[]> {
    return this.prepareImportedAttachments(paths, []);
  }

  async prepareImportedAttachments(paths: string[], data: AttachmentDataInput[]): Promise<DraftAttachment[]> {
    if (paths.length + data.length === 0) return [];
    if (paths.length + data.length > MAX_ATTACHMENTS) {
      throw new Error(`Choose at most ${MAX_ATTACHMENTS} files.`);
    }
    if (this.#state.drafts.length + paths.length + data.length > INPUT_LIMITS.draftAttachments) {
      throw new Error(`Keep at most ${INPUT_LIMITS.draftAttachments} draft attachments.`);
    }
    if (paths.some((path) => !path || path.length > INPUT_LIMITS.path)) {
      throw new Error("An attachment path is invalid.");
    }
    if (
      data.some(
        (item) => item.name.length > INPUT_LIMITS.attachmentName || item.mimeType.length > INPUT_LIMITS.mimeType,
      )
    ) {
      throw new Error("Attachment metadata is too long.");
    }

    const prepared: StoredDraft[] = [];
    let total = 0;
    try {
      for (const sourcePath of paths) {
        const source = await inspectSource(sourcePath);
        const id = randomUUID();
        const targetDirectory = join(this.#draftsRoot, id);
        const name = sanitizeName(source.path);
        const targetPath = join(targetDirectory, name);
        await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
        await copyFile(source.path, targetPath);
        const copied = await stat(targetPath);
        if (copied.size > MAX_FILE_BYTES) {
          await rm(targetDirectory, { recursive: true, force: true });
          throw new Error(`${name} exceeds the 100 MB limit.`);
        }
        total += copied.size;
        if (total > MAX_TOTAL_BYTES) {
          await rm(targetDirectory, { recursive: true, force: true });
          throw new Error("Attachments exceed the 250 MB total limit.");
        }
        const metadata = attachmentMetadata(name);
        prepared.push({
          id,
          name,
          size: copied.size,
          ...metadata,
          previewUrl: attachmentPreviewUrl(id),
          path: targetPath,
          sha256: await sha256(targetPath),
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
      await this.#persist("attachments.prepared");
      return prepared.map(toAttachmentSummary);
    } catch (error) {
      const preparedIds = new Set(prepared.map((draft) => draft.id));
      this.#state.drafts = this.#state.drafts.filter((draft) => !preparedIds.has(draft.id));
      await Promise.all(prepared.map((draft) => rm(dirname(draft.path), { recursive: true, force: true })));
      throw error;
    }
  }

  async discardDraft(id: string): Promise<void> {
    const index = this.#state.drafts.findIndex((draft) => draft.id === id);
    if (index < 0) return;
    const [draft] = this.#state.drafts.splice(index, 1);
    try {
      await this.#persist("attachment-draft.discarded");
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
    if (recipients.length > INPUT_LIMITS.messageRecipients) {
      throw new Error(`A message can have at most ${INPUT_LIMITS.messageRecipients} recipients.`);
    }
    if (recipients.some((id) => !id || id.length > INPUT_LIMITS.identifier)) {
      throw new Error("A message recipient is invalid.");
    }
    if (input.idempotencyKey !== undefined && input.idempotencyKey.length > INPUT_LIMITS.identifier) {
      throw new Error("The idempotency key is too long.");
    }

    const text = input.text.trim();
    if (text.length > INPUT_LIMITS.messageText) throw new Error("Message is too long.");

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

    const createdAt = new Date().toISOString();
    const messageId = randomUUID();
    const attachments = await this.#commitAttachments(
      messageId,
      input.sender,
      recipients,
      messageId,
      createdAt,
      sourcePaths,
    );
    const committedByDraftId = new Map(drafts.map((draft, index) => [draft.id, attachments[index]] as const));
    const message: StoredMessage = {
      id: messageId,
      sender: input.sender,
      text: rewriteAttachmentReferences(text, (reference) => {
        const attachment = committedByDraftId.get(reference.attachmentId);
        return attachment ? { attachmentId: attachment.id, name: attachment.name } : null;
      }),
      attachments,
      replyToMessageId: input.replyToMessageId ?? null,
      createdAt,
    };
    const deliveries = recipients.map<StoredDelivery>((recipientBotId) => ({
      id: randomUUID(),
      messageId,
      recipientBotId,
      queueOrder: this.#nextQueueOrder(recipientBotId),
      status: "queued",
      turnId: null,
      error: null,
      createdAt,
    }));

    this.#state.messages.push(message);
    this.#state.deliveries.push(...deliveries);
    if (input.idempotencyKey) this.#state.idempotency[input.idempotencyKey] = messageId;
    this.#state.drafts = this.#state.drafts.filter((draft) => !(input.draftIds ?? []).includes(draft.id));
    try {
      await this.#persist();
    } catch (error) {
      const deliveryIds = new Set(deliveries.map((delivery) => delivery.id));
      this.#state.messages = this.#state.messages.filter((candidate) => candidate.id !== messageId);
      this.#state.deliveries = this.#state.deliveries.filter((candidate) => !deliveryIds.has(candidate.id));
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
    await Promise.all(drafts.map((draft) => rm(dirname(draft.path), { recursive: true, force: true })));
    return this.#receipt(messageId);
  }

  listQueue(botId: string): QueueSnapshot {
    const positions = this.#queuedPositions();
    return {
      botId,
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
          source: message.sender.kind === "bot" ? "agent" : message.sender.kind === "routine" ? "routine" : "user",
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
          routine:
            message.sender.kind === "routine"
              ? {
                  routineId: message.sender.routineId,
                  runId: message.sender.runId,
                  name: message.sender.routineName,
                  scheduledFor: message.sender.scheduledFor,
                }
              : undefined,
          createdAt: message.createdAt,
          status: delivery.status === "failed" ? "failed" : "completed",
          itemType:
            message.sender.kind === "bot"
              ? "agent-exchange"
              : message.sender.kind === "routine"
                ? "routine"
                : undefined,
        });
      }
    }
    return messages;
  }

  reactionFor(botId: string, messageId: string): MessageReaction | null {
    return (
      this.#state.reactions.find((reaction) => reaction.botId === botId && reaction.messageId === messageId)?.emoji ??
      null
    );
  }

  reactionsFor(botId: string): Map<string, MessageReaction> {
    return new Map(
      this.#state.reactions
        .filter((reaction) => reaction.botId === botId)
        .map((reaction) => [reaction.messageId, reaction.emoji]),
    );
  }

  async setReaction(botId: string, messageId: string, emoji: MessageReaction | null): Promise<void> {
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
    await this.#persist("reaction.updated");
  }

  #sourceTurnId(messageId: string): string | undefined {
    const key = Object.entries(this.#state.idempotency).find(([, value]) => value === messageId)?.[0];
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
    if (
      this.#state.deliveries.some(
        (delivery) =>
          delivery.recipientBotId === botId && (delivery.status === "starting" || delivery.status === "running"),
      )
    ) {
      return null;
    }
    const delivery = this.#state.deliveries
      .filter((candidate) => candidate.recipientBotId === botId && candidate.status === "queued")
      .sort(compareQueueOrder)[0];
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

  findDeliveriesByTurn(botId: string, turnId: string): DeliveryContext[] {
    return this.#state.deliveries
      .filter(
        (delivery) =>
          delivery.recipientBotId === botId &&
          delivery.turnId === turnId &&
          (delivery.status === "starting" || delivery.status === "running"),
      )
      .map((delivery) => this.#context(delivery));
  }

  startingDeliveryForBot(botId: string): DeliveryContext | null {
    const delivery = this.#state.deliveries.find(
      (candidate) => candidate.recipientBotId === botId && candidate.status === "starting" && candidate.turnId === null,
    );
    return delivery ? this.#context(delivery) : null;
  }

  async deleteBotData(botId: string): Promise<void> {
    const previous = structuredClone(this.#state);
    const removedMessageIds = new Set<string>();
    const removedGenerated = this.#state.generatedAttachments.filter((attachment) => attachment.ownerBotId === botId);
    const removedTransferRoots = new Set<string>();
    this.#state.deliveries = this.#state.deliveries.filter((delivery) => delivery.recipientBotId !== botId);
    const remainingMessageIds = new Set(this.#state.deliveries.map((delivery) => delivery.messageId));
    this.#state.messages = this.#state.messages.filter((message) => {
      const keep = remainingMessageIds.has(message.id);
      if (!keep) removedMessageIds.add(message.id);
      if (!keep) {
        for (const attachment of message.attachments) {
          const transferRoot = transferRootForPath(this.#transfersRoot, attachment.path);
          if (transferRoot) removedTransferRoots.add(transferRoot);
        }
      }
      return keep;
    });
    for (const messageId of removedMessageIds) removedTransferRoots.add(join(this.#transfersRoot, messageId));
    this.#state.pausedBotIds = this.#state.pausedBotIds.filter((id) => id !== botId);
    this.#state.reactions = this.#state.reactions.filter(
      (reaction) => reaction.botId !== botId && !removedMessageIds.has(reaction.messageId),
    );
    this.#state.idempotency = Object.fromEntries(
      Object.entries(this.#state.idempotency).filter(([, messageId]) => !removedMessageIds.has(messageId)),
    );
    this.#state.generatedAttachments = this.#state.generatedAttachments.filter(
      (attachment) => attachment.ownerBotId !== botId,
    );
    try {
      await this.#persist(
        "mailbox.agent-data-deleted",
        `mailbox:hard-delete:${randomUUID()}`,
        [
          ...removedTransferRoots,
          ...removedGenerated
            .map((attachment) => generatedRootForPath(this.#transfersRoot, attachment.path))
            .filter((path): path is string => path !== null),
        ],
        true,
      );
    } catch (error) {
      this.#state = previous;
      throw error;
    }
    await this.#drainFileDeletionOutbox();
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
        message.sender.kind === "bot" && message.sender.botId === botId && message.replyToMessageId === messageId,
    );
  }

  hasBotMessageFromTurnTo(botId: string, turnId: string, recipientBotId: string): boolean {
    return this.#state.messages.some((message) => {
      if (message.sender.kind !== "bot" || message.sender.botId !== botId) return false;
      if (this.#sourceTurnId(message.id) !== turnId) return false;
      return this.#state.deliveries.some(
        (delivery) => delivery.messageId === message.id && delivery.recipientBotId === recipientBotId,
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
    await this.#persist("delivery.cancelled");
  }

  async updateQueuedMessage(
    botId: string,
    deliveryId: string,
    text: string,
    keepAttachmentIds: string[],
    attachmentDraftIds: string[],
  ): Promise<void> {
    const delivery = this.#state.deliveries.find(
      (candidate) => candidate.id === deliveryId && candidate.recipientBotId === botId,
    );
    if (!delivery) throw new Error("Queued message was not found.");
    if (delivery.status !== "queued") throw new Error("Only queued messages can be edited.");

    const message = this.#requireMessage(delivery.messageId);
    const keepIds = new Set(keepAttachmentIds);
    if (keepIds.size !== keepAttachmentIds.length) throw new Error("Duplicate attachments.");
    if (keepAttachmentIds.some((id) => !message.attachments.some((item) => item.id === id))) {
      throw new Error("An attachment does not belong to the queued message.");
    }

    const draftIds = new Set(attachmentDraftIds);
    if (draftIds.size !== attachmentDraftIds.length) throw new Error("Duplicate attachment drafts.");
    const drafts = attachmentDraftIds.map((id) => {
      const draft = this.#state.drafts.find((candidate) => candidate.id === id);
      if (!draft) throw new Error(`Attachment draft no longer exists: ${id}`);
      return draft;
    });
    if (keepAttachmentIds.length + drafts.length > MAX_ATTACHMENTS) {
      throw new Error(`Attach at most ${MAX_ATTACHMENTS} files.`);
    }

    const normalizedText = text.trim();
    if (!normalizedText && keepAttachmentIds.length === 0 && drafts.length === 0) {
      throw new Error("Message cannot be empty.");
    }

    const previous = structuredClone(message);
    const oldAttachmentPaths = message.attachments
      .filter((attachment) => !keepIds.has(attachment.id))
      .map((attachment) => attachment.path);
    const draftAttachmentPaths = drafts.map((draft) => draft.path);
    let newAttachmentPaths: string[] = [];
    try {
      const keptAttachments = message.attachments.filter((attachment) => keepIds.has(attachment.id));
      const committedDrafts = draftAttachmentPaths.length
        ? await this.#commitAttachments(
            `${message.id}-edit-${randomUUID()}`,
            message.sender,
            this.#state.deliveries
              .filter((candidate) => candidate.messageId === message.id)
              .map((candidate) => candidate.recipientBotId),
            message.id,
            new Date().toISOString(),
            draftAttachmentPaths,
          )
        : [];
      const replacementAttachments = [...keptAttachments, ...committedDrafts];
      const replacementByReferenceId = new Map([
        ...keptAttachments.map((attachment) => [attachment.id, attachment] as const),
        ...drafts.map((draft, index) => [draft.id, committedDrafts[index]] as const),
      ]);
      newAttachmentPaths = replacementAttachments
        .filter((attachment) => !message.attachments.some((item) => item.id === attachment.id))
        .map((attachment) => attachment.path);
      message.text = rewriteAttachmentReferences(normalizedText, (reference) => {
        const attachment = replacementByReferenceId.get(reference.attachmentId);
        return attachment ? { attachmentId: attachment.id, name: attachment.name } : null;
      });
      message.attachments = replacementAttachments;
      this.#state.drafts = this.#state.drafts.filter((draft) => !draftIds.has(draft.id));
      await this.#persist(
        "message.updated",
        `mailbox:message-updated:${deliveryId}:${randomUUID()}`,
        oldAttachmentPaths,
      );
    } catch (error) {
      message.text = previous.text;
      message.attachments = previous.attachments;
      for (const draft of drafts) {
        if (!this.#state.drafts.some((candidate) => candidate.id === draft.id)) {
          this.#state.drafts.push(draft);
        }
      }
      await Promise.all(newAttachmentPaths.map((path) => rm(dirname(path), { recursive: true, force: true })));
      throw error;
    }
    await Promise.all(drafts.map((draft) => rm(dirname(draft.path), { recursive: true, force: true })));
    await this.#drainFileDeletionOutbox();
  }

  async reorderQueue(botId: string, deliveryIds: string[]): Promise<void> {
    const queued = this.#state.deliveries.filter(
      (delivery) => delivery.recipientBotId === botId && delivery.status === "queued",
    );
    const expected = new Set(queued.map((delivery) => delivery.id));
    if (
      deliveryIds.length !== queued.length ||
      new Set(deliveryIds).size !== deliveryIds.length ||
      deliveryIds.some((deliveryId) => !expected.has(deliveryId))
    ) {
      throw new Error("Queue order is stale. Refresh the queue and try again.");
    }
    const orders = new Map(deliveryIds.map((deliveryId, index) => [deliveryId, index]));
    for (const delivery of queued) {
      delivery.queueOrder = orders.get(delivery.id) ?? delivery.queueOrder;
    }
    await this.#persist("queue.reordered");
  }

  async markSteering(deliveryId: string, turnId: string): Promise<void> {
    await this.#updateDelivery(deliveryId, ["queued"], {
      status: "starting",
      turnId,
      error: null,
    });
  }

  async restoreQueued(deliveryId: string): Promise<void> {
    await this.#updateDelivery(deliveryId, ["starting"], {
      status: "queued",
      turnId: null,
      error: null,
    });
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
    const generated = this.#state.generatedAttachments.find((candidate) => candidate.id === id);
    if (generated) return resolveManagedAttachment(this.#transfersRoot, generated);
    return null;
  }

  async verifyDeliveryAttachments(deliveryId: string): Promise<void> {
    const delivery = this.#state.deliveries.find((candidate) => candidate.id === deliveryId);
    if (!delivery) throw new Error(`Unknown delivery: ${deliveryId}`);
    const message = this.#requireMessage(delivery.messageId);
    for (const attachment of message.attachments) {
      const resolved = await resolveManagedAttachment(this.#transfersRoot, attachment);
      if (!resolved) throw new Error(`Managed attachment is missing or has changed: ${attachment.name}`);
    }
  }

  async storeGeneratedAttachment(input: {
    sourcePath?: string;
    bytes?: Uint8Array;
    name?: string;
    mimeType?: string;
    ownerBotId?: string;
    ownerThreadId?: string | null;
  }): Promise<AttachmentSummary> {
    if ((input.sourcePath === undefined) === (input.bytes === undefined)) {
      throw new Error("Provide exactly one generated image source.");
    }

    const id = randomUUID();
    const source = input.sourcePath === undefined ? null : await inspectSource(input.sourcePath);
    const bytes = input.bytes === undefined ? null : normalizeBytes(input.bytes);
    const size = source?.size ?? bytes?.byteLength ?? 0;
    if (size > MAX_FILE_BYTES) throw new Error("Generated image exceeds the 100 MB limit.");

    const name = sanitizeName(input.name ?? (source ? basename(source.path) : "generated-image.png"));
    const metadata = attachmentMetadata(name, input.mimeType);
    const generatedRoot = join(this.#transfersRoot, "generated", id);
    const targetPath = join(generatedRoot, name);
    await mkdir(generatedRoot, { recursive: true, mode: 0o700 });
    try {
      if (source) await copyFile(source.path, targetPath);
      else if (bytes) await writeFile(targetPath, bytes, { mode: 0o600 });
      else throw new Error("Generated image bytes are missing.");
      const stored = await stat(targetPath);
      if (stored.size > MAX_FILE_BYTES) throw new Error("Generated image exceeds the 100 MB limit.");
      const attachment: StoredAttachment = {
        id,
        name,
        size: stored.size,
        ...metadata,
        previewUrl: attachmentPreviewUrl(id),
        path: targetPath,
        sha256: await sha256(targetPath),
      };
      const generatedAttachment: StoredGeneratedAttachment = {
        ...attachment,
        ...(input.ownerBotId ? { ownerBotId: input.ownerBotId } : {}),
        ...(input.ownerThreadId !== undefined ? { ownerThreadId: input.ownerThreadId } : {}),
      };
      await writeTransferManifest(generatedRoot, {
        version: 1,
        kind: "generated-attachment",
        generatedAttachmentId: id,
        ...(input.ownerBotId ? { ownerBotId: input.ownerBotId } : {}),
        ...(input.ownerThreadId !== undefined ? { ownerThreadId: input.ownerThreadId } : {}),
        createdAt: new Date().toISOString(),
        attachments: [manifestAttachment(generatedAttachment, name)],
      });
      this.#state.generatedAttachments.push(generatedAttachment);
      try {
        await this.#persist("attachment.generated");
      } catch (error) {
        this.#state.generatedAttachments = this.#state.generatedAttachments.filter((candidate) => candidate.id !== id);
        throw error;
      }
      return toAttachmentSummary(attachment);
    } catch (error) {
      await rm(generatedRoot, { recursive: true, force: true });
      throw error;
    }
  }

  async listExportAttachments(): Promise<ExportedAttachmentFile[]> {
    const files: ExportedAttachmentFile[] = [];
    for (const [messageIndex, message] of this.#state.messages.entries()) {
      for (const attachment of message.attachments) {
        const resolved = await resolveManagedAttachment(this.#transfersRoot, attachment);
        if (!resolved) continue;
        files.push({
          sourcePath: resolved.path,
          relativePath: join(
            "attachments",
            `${messageIndex + 1}-${safeArchiveSegment(message.id)}`,
            `${safeArchiveSegment(attachment.id)}-${safeArchiveSegment(attachment.name)}`,
          ),
        });
      }
    }
    for (const attachment of this.#state.generatedAttachments) {
      const resolved = await resolveManagedAttachment(this.#transfersRoot, attachment);
      if (!resolved) continue;
      files.push({
        sourcePath: resolved.path,
        relativePath: join(
          "attachments",
          "generated",
          `${safeArchiveSegment(attachment.id)}-${safeArchiveSegment(attachment.name)}`,
        ),
      });
    }
    return files;
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

  #nextQueueOrder(botId: string): number {
    return (
      this.#state.deliveries
        .filter((delivery) => delivery.recipientBotId === botId)
        .reduce((max, delivery) => Math.max(max, delivery.queueOrder), -1) + 1
    );
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
    const queued = [...this.#state.deliveries]
      .filter((delivery) => delivery.status === "queued")
      .sort(compareQueueOrder);
    for (const delivery of queued) {
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

  async #commitAttachments(
    transferId: string,
    sender: StoredMessage["sender"],
    recipientBotIds: string[],
    messageId: string,
    createdAt: string,
    sourcePaths: string[],
  ): Promise<StoredAttachment[]> {
    if (sourcePaths.length === 0) return [];
    const inspected = await Promise.all(sourcePaths.map(inspectSource));
    const temporaryRoot = join(this.#transfersRoot, `.tmp-${transferId}`);
    const finalRoot = join(this.#transfersRoot, transferId);
    await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
    const usedNames = new Set<string>();
    try {
      const attachments: StoredAttachment[] = [];
      let total = 0;
      for (const source of inspected) {
        const name = uniqueName(sanitizeName(source.path), usedNames);
        const id = randomUUID();
        const targetPath = join(temporaryRoot, name);
        await copyFile(source.path, targetPath);
        const copied = await stat(targetPath);
        if (copied.size > MAX_FILE_BYTES) throw new Error(`${name} exceeds the 100 MB limit.`);
        total += copied.size;
        if (total > MAX_TOTAL_BYTES) throw new Error("Attachments exceed the 250 MB total limit.");
        const metadata = attachmentMetadata(name);
        attachments.push({
          id,
          name,
          size: copied.size,
          ...metadata,
          previewUrl: attachmentPreviewUrl(id),
          path: join(finalRoot, name),
          sha256: await sha256(targetPath),
        });
      }
      await writeTransferManifest(temporaryRoot, {
        version: 1,
        kind: "message-transfer",
        transferId,
        messageId,
        sender,
        recipientBotIds,
        createdAt,
        attachments: attachments.map((attachment) => manifestAttachment(attachment, attachment.name)),
      });
      await rename(temporaryRoot, finalRoot);
      return attachments;
    } catch (error) {
      await rm(temporaryRoot, { recursive: true, force: true });
      throw error;
    }
  }

  async #updateDelivery(id: string, allowed: QueueDeliveryStatus[], patch: Partial<StoredDelivery>): Promise<void> {
    const delivery = this.#state.deliveries.find((candidate) => candidate.id === id);
    if (!delivery) throw new Error(`Unknown delivery: ${id}`);
    if (!allowed.includes(delivery.status)) return;
    Object.assign(delivery, patch);
    await this.#persist("delivery.updated");
  }

  #requireMessage(id: string): StoredMessage {
    const message = this.#state.messages.find((candidate) => candidate.id === id);
    if (!message) throw new Error(`Mailbox message is missing: ${id}`);
    return message;
  }

  async #readState(): Promise<StoredState> {
    try {
      const value = JSON.parse(await readFile(this.#statePath, "utf8"));
      if (!isStoredState(value)) {
        throw new Error("Mailbox state is corrupt or from a newer OpenBot version; refusing to overwrite it.");
      }
      return value;
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return structuredClone(EMPTY_STATE);
      throw error;
    }
  }

  async #persist(
    eventType = "mailbox.updated",
    commandId = `mailbox:${eventType}:${randomUUID()}`,
    fileDeletions: string[] = [],
    rebaseHistory = false,
  ): Promise<void> {
    this.#database.replaceMailboxState(commandId, this.#state, eventType, fileDeletions, rebaseHistory);
  }

  async #drainFileDeletionOutbox(): Promise<void> {
    for (const item of this.#database.pendingFileDeletions()) {
      try {
        await rm(item.path, { recursive: true, force: true });
        this.#database.completeFileDeletion(item.id);
      } catch (error) {
        this.#database.failFileDeletion(item.id, error instanceof Error ? error.message : String(error));
      }
    }
  }
}

async function resolveManagedAttachment(
  root: string,
  attachment: StoredAttachment,
): Promise<{ path: string; mimeType: string } | null> {
  try {
    const [canonicalRoot, canonicalPath] = await Promise.all([realpath(root), realpath(attachment.path)]);
    if (!isWithin(canonicalRoot, canonicalPath)) return null;
    const metadata = await stat(canonicalPath);
    if (!metadata.isFile() || metadata.size !== attachment.size) return null;
    if ((await sha256(canonicalPath)) !== attachment.sha256) return null;
    return { path: canonicalPath, mimeType: attachment.mimeType };
  } catch {
    return null;
  }
}

async function writeTransferManifest(directory: string, manifest: TransferManifest): Promise<void> {
  await writeFile(join(directory, TRANSFER_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function manifestAttachment(
  attachment: StoredAttachment,
  relativePath: string,
): TransferManifest["attachments"][number] {
  return {
    id: attachment.id,
    name: attachment.name,
    relativePath,
    size: attachment.size,
    kind: attachment.kind,
    mimeType: attachment.mimeType,
    previewKind: attachment.previewKind,
    sha256: attachment.sha256,
  };
}

async function inspectSource(sourcePath: string): Promise<{ path: string; size: number }> {
  const path = await realpath(sourcePath);
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`Only regular files can be attached: ${basename(path)}`);
  if (metadata.size > MAX_FILE_BYTES) throw new Error(`${basename(path)} exceeds the 100 MB limit.`);
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

function safeArchiveSegment(value: string): string {
  return (
    basename(value)
      .replace(/[^\p{L}\p{N}._ -]+/gu, "-")
      .replace(/^\.+/, "")
      .slice(0, 120) || "item"
  );
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

function normalizeStoredState(value: StoredState): StoredState {
  const nextOrderByBot = new Map<string, number>();
  const deliveries = value.deliveries.map((delivery) => {
    const fallback = nextOrderByBot.get(delivery.recipientBotId) ?? 0;
    const queueOrder = Number.isFinite(delivery.queueOrder) ? delivery.queueOrder : fallback;
    nextOrderByBot.set(delivery.recipientBotId, Math.max(fallback, queueOrder + 1));
    return { ...delivery, queueOrder };
  });
  return {
    ...value,
    version: 3,
    generatedAttachments: value.generatedAttachments ?? [],
    deliveries,
  };
}

function compareQueueOrder(left: StoredDelivery, right: StoredDelivery): number {
  return (
    left.queueOrder - right.queueOrder ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

function isStoredState(value: unknown): value is StoredState {
  return (
    isRecord(value) &&
    (value.version === 1 || value.version === 2 || value.version === 3) &&
    Array.isArray(value.messages) &&
    value.messages.every(isStoredMessage) &&
    Array.isArray(value.deliveries) &&
    value.deliveries.every(isStoredDelivery) &&
    Array.isArray(value.drafts) &&
    value.drafts.every(isStoredDraft) &&
    (value.generatedAttachments === undefined ||
      (Array.isArray(value.generatedAttachments) && value.generatedAttachments.every(isStoredGeneratedAttachment))) &&
    Array.isArray(value.pausedBotIds) &&
    value.pausedBotIds.every((item) => isString(item)) &&
    isRecord(value.idempotency) &&
    Object.values(value.idempotency).every((item) => isString(item)) &&
    Array.isArray(value.reactions) &&
    value.reactions.every(isStoredReaction)
  );
}

function isStoredAttachment(value: unknown): value is StoredAttachment {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.name) &&
    isNumber(value.size) &&
    (value.kind === "image" || value.kind === "file") &&
    isString(value.mimeType) &&
    (value.previewKind === "image" ||
      value.previewKind === "pdf" ||
      value.previewKind === "text" ||
      value.previewKind === "none") &&
    (isString(value.previewUrl) || value.previewUrl === undefined) &&
    isString(value.path) &&
    isString(value.sha256)
  );
}

function isStoredGeneratedAttachment(value: unknown): value is StoredGeneratedAttachment {
  if (!isRecord(value)) return false;
  if (!isStoredAttachment(value)) return false;
  return (
    (value.ownerBotId === undefined || isString(value.ownerBotId)) &&
    (value.ownerThreadId === undefined || value.ownerThreadId === null || isString(value.ownerThreadId))
  );
}

function isStoredDraft(value: unknown): value is StoredDraft {
  return isRecord(value) && isString(value.createdAt) && isStoredAttachment(value);
}

function isStoredMessage(value: unknown): value is StoredMessage {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isRecord(value.sender) &&
    (value.sender.kind === "user" ||
      (value.sender.kind === "bot" && isString(value.sender.botId)) ||
      (value.sender.kind === "routine" &&
        isString(value.sender.routineId) &&
        isString(value.sender.runId) &&
        isString(value.sender.routineName) &&
        isString(value.sender.scheduledFor))) &&
    isString(value.text) &&
    Array.isArray(value.attachments) &&
    value.attachments.every(isStoredAttachment) &&
    (isString(value.replyToMessageId) || value.replyToMessageId === null) &&
    isString(value.createdAt)
  );
}

function isStoredDelivery(value: unknown): value is StoredDelivery {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.messageId) &&
    isString(value.recipientBotId) &&
    (value.queueOrder === undefined || (isNumber(value.queueOrder) && Number.isFinite(value.queueOrder))) &&
    (value.status === "queued" ||
      value.status === "starting" ||
      value.status === "running" ||
      value.status === "completed" ||
      value.status === "failed" ||
      value.status === "interrupted" ||
      value.status === "cancelled") &&
    (isString(value.turnId) || value.turnId === null) &&
    (isString(value.error) || value.error === null) &&
    isString(value.createdAt)
  );
}

function isStoredReaction(value: unknown): value is StoredReaction {
  return (
    isRecord(value) &&
    isString(value.botId) &&
    isString(value.messageId) &&
    isMessageReaction(value.emoji) &&
    isString(value.updatedAt)
  );
}

function isWithin(root: string, path: string): boolean {
  const candidate = relative(root, path);
  return candidate !== "" && !candidate.startsWith("..") && !isAbsolute(candidate);
}

function transferRootForPath(root: string, path: string): string | null {
  const candidate = relative(root, path);
  if (!candidate || candidate.startsWith("..") || isAbsolute(candidate)) return null;
  const segment = candidate.split(/[\\/]/u)[0];
  return segment && !segment.startsWith(".") ? join(root, segment) : null;
}

function generatedRootForPath(root: string, path: string): string | null {
  const candidate = relative(root, path);
  if (!candidate || candidate.startsWith("..") || isAbsolute(candidate)) return null;
  const segments = candidate.split(/[\\/]/u);
  if (segments[0] !== "generated" || !segments[1] || segments[1].startsWith(".")) return null;
  return join(root, "generated", segments[1]);
}
