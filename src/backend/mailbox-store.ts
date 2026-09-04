import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  type FileHandle,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";
import {
  attachmentMimeTypeForName,
  isSupportedAttachmentName,
  SUPPORTED_ATTACHMENT_DESCRIPTION,
} from "@openbot/contracts/attachment-files";
import { rewriteAttachmentReferences } from "@openbot/contracts/attachment-references";
import { ATTACHMENT_LIMITS, INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  AgentRuntimeWorkItem,
  AttachmentDataInput,
  AttachmentKind,
  AttachmentPreviewKind,
  AttachmentSummary,
  ConversationMessage,
  ConversationReaction,
  ConversationReactionActor,
  ConversationSnapshot,
  DraftAttachment,
  MessageReaction,
  QueueDelivery,
  QueueDeliveryStatus,
  QueuedMessageReceipt,
  QueueSnapshot,
} from "@openbot/contracts/ipc";
import {
  AGENT_RUNTIME_ATTENTION_LIMIT,
  AGENT_RUNTIME_TEXT_LIMIT,
  AGENT_RUNTIME_WORKING_ITEMS_LIMIT,
  isMessageReaction,
} from "@openbot/contracts/ipc";
import { type DynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
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
  ownerAgentId?: string;
  ownerThreadId?: string | null;
}

interface StoredDraft extends StoredAttachment {
  createdAt: string;
}

interface StoredMessage {
  id: string;
  sender:
    | { kind: "user" }
    | { kind: "agent"; agentId: string }
    | { kind: "routine"; routineId: string; runId: string; routineName: string; scheduledFor: string };
  text: string;
  attachments: StoredAttachment[];
  replyToMessageId: string | null;
  createdAt: string;
}

interface StoredDelivery {
  id: string;
  messageId: string;
  recipientAgentId: string;
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
  pausedAgentIds: string[];
  idempotency: Record<string, string>;
  reactions: StoredReaction[];
}

interface StoredReaction {
  agentId: string;
  messageId: string;
  emoji: MessageReaction;
  actor: ConversationReactionActor;
  updatedAt: string;
}

interface EnqueueInput {
  sender: StoredMessage["sender"];
  recipientAgentIds: string[];
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
  recipientAgentIds?: string[];
  ownerAgentId?: string;
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

export interface GeneratedAttachmentSource {
  path: string;
  handle: FileHandle;
}

const EMPTY_STATE: StoredState = {
  version: 3,
  messages: [],
  deliveries: [],
  drafts: [],
  generatedAttachments: [],
  pausedAgentIds: [],
  idempotency: {},
  reactions: [],
};

export class MailboxStore {
  readonly #statePath: string;
  readonly #draftsRoot: string;
  readonly #transfersRoot: string;
  readonly #database: OpenBotDatabase;
  readonly #stagedGeneratedAttachments = new Map<string, StoredGeneratedAttachment>();
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
    const stored = this.#database.readMailboxState();
    if (stored !== null && stored !== undefined) {
      const persisted = toCurrentMailboxState(stored);
      if (!persisted || !isStoredState(persisted)) throw new Error("Stored mailbox projection is invalid.");
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
        assertSupportedAttachmentName(name);
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
        assertSupportedAttachmentName(name);
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

    const recipients = [...new Set(input.recipientAgentIds)];
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
    const deliveries = recipients.map<StoredDelivery>((recipientAgentId) => ({
      id: randomUUID(),
      messageId,
      recipientAgentId,
      queueOrder: this.#nextQueueOrder(recipientAgentId),
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

  listQueue(agentId: string): QueueSnapshot {
    const positions = this.#queuedPositions();
    return {
      agentId,
      deliveries: this.#state.deliveries
        .filter((delivery) => delivery.recipientAgentId === agentId)
        .map((delivery) => this.#publicDelivery(delivery, positions)),
    };
  }

  listRuntimeWork(agentIds: readonly string[], failedTurns: ReadonlyMap<string, string>): AgentRuntimeWorkItem[] {
    const targetAgentIds = new Set(agentIds);
    const working: StoredDelivery[] = [];
    const failed: StoredDelivery[] = [];
    const workingAgentIds = new Set<string>();
    const failedAgentIds = new Set<string>();
    for (const delivery of this.#state.deliveries) {
      if (!targetAgentIds.has(delivery.recipientAgentId)) continue;
      const isWorking = delivery.status === "starting" || delivery.status === "running";
      const isCurrentFailure =
        delivery.status === "failed" && delivery.turnId === failedTurns.get(delivery.recipientAgentId);
      if (!isWorking && !isCurrentFailure) continue;
      const seenAgentIds = isCurrentFailure ? failedAgentIds : workingAgentIds;
      if (seenAgentIds.has(delivery.recipientAgentId)) continue;
      seenAgentIds.add(delivery.recipientAgentId);
      (isCurrentFailure ? failed : working).push(delivery);
    }
    const selected = [
      ...failed.slice(0, AGENT_RUNTIME_ATTENTION_LIMIT),
      ...working.slice(0, AGENT_RUNTIME_WORKING_ITEMS_LIMIT),
    ];
    const messageIds = new Set(selected.map((delivery) => delivery.messageId));
    const messages = new Map(
      this.#state.messages.filter((message) => messageIds.has(message.id)).map((message) => [message.id, message]),
    );
    return selected.map((delivery) => {
      const message = messages.get(delivery.messageId);
      if (!message) throw new Error(`Mailbox message is missing: ${delivery.messageId}`);
      if (delivery.status !== "starting" && delivery.status !== "running" && delivery.status !== "failed") {
        throw new Error(`Mailbox runtime delivery has an invalid status: ${delivery.status}`);
      }
      return {
        id: delivery.id,
        agentId: delivery.recipientAgentId,
        turnId: delivery.turnId,
        status: delivery.status,
        text: message.text.slice(0, AGENT_RUNTIME_TEXT_LIMIT),
        error: delivery.error?.slice(0, AGENT_RUNTIME_TEXT_LIMIT) ?? null,
      };
    });
  }

  conversationMessages(agentId: string): ConversationMessage[] {
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
      if (message.sender.kind === "agent" && message.sender.agentId === agentId) {
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
            senderAgentId: agentId,
            recipientAgentIds: deliveries.map((item) => item.recipientAgentId),
            replyToMessageId: message.replyToMessageId,
            deliveries: deliveries.map((item) => {
              const delivery = this.#publicDelivery(item, positions);
              return {
                id: delivery.id,
                recipientAgentId: delivery.recipientAgentId,
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
        if (storedDelivery.recipientAgentId !== agentId) continue;
        const delivery = this.#publicDelivery(storedDelivery, positions);
        messages.push({
          id: delivery.id,
          turnId: storedDelivery.turnId ?? undefined,
          author: message.sender.kind === "agent" ? "agent" : "user",
          source: message.sender.kind === "agent" ? "agent" : message.sender.kind === "routine" ? "routine" : "user",
          text: message.text,
          senderAgentId: message.sender.kind === "agent" ? message.sender.agentId : undefined,
          attachments: message.attachments.map(toAttachmentSummary),
          replyToMessageId: message.replyToMessageId,
          delivery: {
            id: delivery.id,
            status: delivery.status,
            position: delivery.position,
          },
          exchange:
            message.sender.kind === "agent"
              ? {
                  direction: "incoming",
                  messageId: message.id,
                  senderAgentId: message.sender.agentId,
                  recipientAgentIds: deliveries.map((item) => item.recipientAgentId),
                  replyToMessageId: message.replyToMessageId,
                  deliveries: deliveries.map((item) => {
                    const publicItem = this.#publicDelivery(item, positions);
                    return {
                      id: publicItem.id,
                      recipientAgentId: publicItem.recipientAgentId,
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
            message.sender.kind === "agent"
              ? "agent-exchange"
              : message.sender.kind === "routine"
                ? "routine"
                : undefined,
        });
      }
    }
    return messages;
  }

  reactionFor(
    agentId: string,
    messageId: string,
    actor: ConversationReactionActor = { kind: "user" },
  ): MessageReaction | null {
    return (
      this.#state.reactions.find(
        (reaction) =>
          reaction.agentId === agentId &&
          reaction.messageId === messageId &&
          reactionActorsEqual(reaction.actor, actor),
      )?.emoji ?? null
    );
  }

  reactionsFor(agentId: string): Map<string, ConversationReaction[]> {
    const result = new Map<string, ConversationReaction[]>();
    for (const reaction of this.#state.reactions) {
      if (reaction.agentId !== agentId) continue;
      const reactions = result.get(reaction.messageId) ?? [];
      reactions.push({ emoji: reaction.emoji, actor: reaction.actor });
      result.set(reaction.messageId, reactions);
    }
    for (const reactions of result.values()) reactions.sort(compareReactionActors);
    return result;
  }

  async setReaction(
    agentId: string,
    messageId: string,
    actor: ConversationReactionActor,
    emoji: MessageReaction | null,
  ): Promise<void> {
    const index = this.#state.reactions.findIndex(
      (reaction) =>
        reaction.agentId === agentId && reaction.messageId === messageId && reactionActorsEqual(reaction.actor, actor),
    );
    if (emoji === null) {
      if (index < 0) return;
      this.#state.reactions.splice(index, 1);
    } else if (index >= 0) {
      this.#state.reactions[index] = {
        agentId,
        messageId,
        emoji,
        actor,
        updatedAt: new Date().toISOString(),
      };
    } else {
      this.#state.reactions.push({
        agentId,
        messageId,
        emoji,
        actor,
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

  senderAgentIdsForRecipient(agentId: string): string[] {
    const result = new Set<string>();
    for (const delivery of this.#state.deliveries) {
      if (delivery.recipientAgentId !== agentId) continue;
      const sender = this.#requireMessage(delivery.messageId).sender;
      if (sender.kind === "agent") result.add(sender.agentId);
    }
    return [...result];
  }

  nextQueued(agentId: string): DeliveryContext | null {
    if (
      this.#state.deliveries.some(
        (delivery) =>
          delivery.recipientAgentId === agentId && (delivery.status === "starting" || delivery.status === "running"),
      )
    ) {
      return null;
    }
    const delivery = this.#state.deliveries
      .filter((candidate) => candidate.recipientAgentId === agentId && candidate.status === "queued")
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

  findDeliveriesByTurn(agentId: string, turnId: string): DeliveryContext[] {
    return this.#state.deliveries
      .filter(
        (delivery) =>
          delivery.recipientAgentId === agentId &&
          delivery.turnId === turnId &&
          (delivery.status === "starting" || delivery.status === "running"),
      )
      .map((delivery) => this.#context(delivery));
  }

  startingDeliveryForAgent(agentId: string): DeliveryContext | null {
    const delivery = this.#state.deliveries.find(
      (candidate) =>
        candidate.recipientAgentId === agentId && candidate.status === "starting" && candidate.turnId === null,
    );
    return delivery ? this.#context(delivery) : null;
  }

  async deleteAgentData(agentId: string): Promise<void> {
    const previous = structuredClone(this.#state);
    const removedMessageIds = new Set<string>();
    const removedGenerated = this.#state.generatedAttachments.filter(
      (attachment) => attachment.ownerAgentId === agentId,
    );
    const removedTransferRoots = new Set<string>();
    this.#state.deliveries = this.#state.deliveries.filter((delivery) => delivery.recipientAgentId !== agentId);
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
    this.#state.pausedAgentIds = this.#state.pausedAgentIds.filter((id) => id !== agentId);
    this.#state.reactions = this.#state.reactions.filter(
      (reaction) => reaction.agentId !== agentId && !removedMessageIds.has(reaction.messageId),
    );
    this.#state.idempotency = Object.fromEntries(
      Object.entries(this.#state.idempotency).filter(([, messageId]) => !removedMessageIds.has(messageId)),
    );
    this.#state.generatedAttachments = this.#state.generatedAttachments.filter(
      (attachment) => attachment.ownerAgentId !== agentId,
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

  chainOriginAgentId(messageId: string): string | null {
    const visited = new Set<string>();
    let message = this.#state.messages.find((candidate) => candidate.id === messageId);
    while (message && !visited.has(message.id)) {
      visited.add(message.id);
      const parent = message.replyToMessageId
        ? this.#state.messages.find((candidate) => candidate.id === message?.replyToMessageId)
        : undefined;
      if (!parent) return message.sender.kind === "agent" ? message.sender.agentId : null;
      message = parent;
    }
    return null;
  }

  hasReplyFrom(agentId: string, messageId: string): boolean {
    return this.#state.messages.some(
      (message) =>
        message.sender.kind === "agent" && message.sender.agentId === agentId && message.replyToMessageId === messageId,
    );
  }

  hasAgentMessageFromTurnTo(agentId: string, turnId: string, recipientAgentId: string): boolean {
    return this.#state.messages.some((message) => {
      if (message.sender.kind !== "agent" || message.sender.agentId !== agentId) return false;
      if (this.#sourceTurnId(message.id) !== turnId) return false;
      return this.#state.deliveries.some(
        (delivery) => delivery.messageId === message.id && delivery.recipientAgentId === recipientAgentId,
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

  async cancel(agentId: string, deliveryId: string): Promise<void> {
    this.cancelNow(agentId, deliveryId);
  }

  cancelNow(agentId: string, deliveryId: string): void {
    const delivery = this.#state.deliveries.find(
      (candidate) => candidate.id === deliveryId && candidate.recipientAgentId === agentId,
    );
    if (!delivery) throw new Error("Queued message was not found.");
    if (delivery.status !== "queued") throw new Error("Only queued messages can be cancelled.");
    delivery.status = "cancelled";
    try {
      this.#persist("delivery.cancelled");
    } catch (error) {
      delivery.status = "queued";
      throw error;
    }
  }

  restorePersistedState(): void {
    const persisted = toCurrentMailboxState(this.#database.readMailboxState());
    if (!persisted || !isStoredState(persisted)) throw new Error("Stored mailbox projection is invalid.");
    this.#state = normalizeStoredState(persisted);
  }

  async updateQueuedMessage(
    agentId: string,
    deliveryId: string,
    text: string,
    keepAttachmentIds: string[],
    attachmentDraftIds: string[],
  ): Promise<void> {
    const delivery = this.#state.deliveries.find(
      (candidate) => candidate.id === deliveryId && candidate.recipientAgentId === agentId,
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
              .map((candidate) => candidate.recipientAgentId),
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

  async reorderQueue(agentId: string, deliveryIds: string[]): Promise<void> {
    const queued = this.#state.deliveries.filter(
      (delivery) => delivery.recipientAgentId === agentId && delivery.status === "queued",
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

  async stageGeneratedAttachments(input: {
    sources: GeneratedAttachmentSource[];
    ownerAgentId?: string;
    ownerThreadId?: string | null;
  }): Promise<AttachmentSummary[]> {
    if (input.sources.length === 0 || input.sources.length > MAX_ATTACHMENTS) {
      throw new Error(`Attach between 1 and ${MAX_ATTACHMENTS} files.`);
    }
    const sources = await Promise.all(
      input.sources.map(async (source) => {
        const metadata = await source.handle.stat();
        if (!metadata.isFile()) throw new Error(`Attachment is not a file: ${source.path}`);
        if (metadata.size > MAX_FILE_BYTES) throw new Error(`${basename(source.path)} exceeds the 100 MB limit.`);
        assertSupportedAttachmentName(source.path);
        return { ...source, size: metadata.size };
      }),
    );
    const total = sources.reduce((sum, source) => sum + source.size, 0);
    if (total > MAX_TOTAL_BYTES) throw new Error("Attachments exceed the 250 MB total limit.");

    const usedNames = new Set<string>();
    const entries = sources.map((source) => {
      const id = randomUUID();
      const name = uniqueName(sanitizeName(source.path), usedNames);
      const generatedRoot = join(this.#transfersRoot, "generated", id);
      return { id, name, source, generatedRoot, targetPath: join(generatedRoot, name) };
    });
    const storedIds = new Set<string>(entries.map((entry) => entry.id));

    try {
      const attachments: StoredGeneratedAttachment[] = [];
      let copiedTotal = 0;
      for (const entry of entries) {
        await mkdir(entry.generatedRoot, { recursive: true, mode: 0o700 });
        await copyOpenedFile(entry.source.handle, entry.targetPath, entry.name, MAX_TOTAL_BYTES - copiedTotal);
        const copied = await stat(entry.targetPath);
        if (copied.size > MAX_FILE_BYTES) throw new Error(`${entry.name} exceeds the 100 MB limit.`);
        copiedTotal += copied.size;
        if (copiedTotal > MAX_TOTAL_BYTES) throw new Error("Attachments exceed the 250 MB total limit.");
        const attachment: StoredGeneratedAttachment = {
          id: entry.id,
          name: entry.name,
          size: copied.size,
          ...attachmentMetadata(entry.name),
          previewUrl: attachmentPreviewUrl(entry.id),
          path: entry.targetPath,
          sha256: await sha256(entry.targetPath),
          ...(input.ownerAgentId ? { ownerAgentId: input.ownerAgentId } : {}),
          ...(input.ownerThreadId !== undefined ? { ownerThreadId: input.ownerThreadId } : {}),
        };
        await writeTransferManifest(entry.generatedRoot, {
          version: 1,
          kind: "generated-attachment",
          generatedAttachmentId: entry.id,
          ...(input.ownerAgentId ? { ownerAgentId: input.ownerAgentId } : {}),
          ...(input.ownerThreadId !== undefined ? { ownerThreadId: input.ownerThreadId } : {}),
          createdAt: new Date().toISOString(),
          attachments: [manifestAttachment(attachment, entry.name)],
        });
        attachments.push(attachment);
      }
      for (const attachment of attachments) this.#stagedGeneratedAttachments.set(attachment.id, attachment);
      return attachments.map(toAttachmentSummary);
    } catch (error) {
      for (const id of storedIds) this.#stagedGeneratedAttachments.delete(id);
      await Promise.allSettled(entries.map((entry) => rm(entry.generatedRoot, { recursive: true, force: true })));
      throw error;
    }
  }

  persistGeneratedAttachmentsWithConversation(
    snapshot: ConversationSnapshot,
    eventType: string,
    detail: unknown,
    attachmentIds: string[],
  ): ConversationSnapshot {
    const staged = attachmentIds.map((id) => {
      const attachment = this.#stagedGeneratedAttachments.get(id);
      if (!attachment) throw new Error(`Staged generated attachment is missing: ${id}`);
      return attachment;
    });
    const nextState: StoredState = {
      ...this.#state,
      generatedAttachments: [...this.#state.generatedAttachments, ...staged],
    };
    const persisted = this.#database.persistConversationAndMailbox(
      snapshot,
      eventType,
      detail,
      nextState,
      "attachment.generated-batch",
    );
    this.#state = nextState;
    for (const id of attachmentIds) this.#stagedGeneratedAttachments.delete(id);
    return persisted;
  }

  async discardStagedGeneratedAttachments(attachmentIds: string[]): Promise<void> {
    const ids = new Set(attachmentIds);
    const removed = attachmentIds.flatMap((id) => {
      const attachment = this.#stagedGeneratedAttachments.get(id);
      return attachment ? [attachment] : [];
    });
    if (removed.length === 0) return;

    for (const id of ids) this.#stagedGeneratedAttachments.delete(id);
    const generatedRoots = removed
      .map((attachment) => generatedRootForPath(this.#transfersRoot, attachment.path))
      .filter((path): path is string => path !== null);
    await Promise.allSettled(generatedRoots.map((path) => rm(path, { recursive: true, force: true })));
  }

  async storeGeneratedAttachment(input: {
    sourcePath?: string;
    bytes?: Uint8Array;
    name?: string;
    mimeType?: string;
    ownerAgentId?: string;
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
        ...(input.ownerAgentId ? { ownerAgentId: input.ownerAgentId } : {}),
        ...(input.ownerThreadId !== undefined ? { ownerThreadId: input.ownerThreadId } : {}),
      };
      await writeTransferManifest(generatedRoot, {
        version: 1,
        kind: "generated-attachment",
        generatedAttachmentId: id,
        ...(input.ownerAgentId ? { ownerAgentId: input.ownerAgentId } : {}),
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

  #nextQueueOrder(agentId: string): number {
    return (
      this.#state.deliveries
        .filter((delivery) => delivery.recipientAgentId === agentId)
        .reduce((max, delivery) => Math.max(max, delivery.queueOrder), -1) + 1
    );
  }

  #publicDelivery(
    delivery: StoredDelivery,
    positions = this.#queuedPositions(),
    message = this.#requireMessage(delivery.messageId),
  ): QueueDelivery {
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
      const position = (counts.get(delivery.recipientAgentId) ?? 0) + 1;
      counts.set(delivery.recipientAgentId, position);
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
            recipientAgentId: item.recipientAgentId,
            status: item.status,
            position: item.position,
          };
        }),
    };
  }

  async #commitAttachments(
    transferId: string,
    sender: StoredMessage["sender"],
    recipientAgentIds: string[],
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
        recipientAgentIds,
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
      const value = toCurrentMailboxState(JSON.parse(await readFile(this.#statePath, "utf8")));
      if (!value || !isStoredState(value)) {
        throw new Error("Mailbox state is corrupt or from a newer OpenBot version; refusing to overwrite it.");
      }
      return value;
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return structuredClone(EMPTY_STATE);
      throw error;
    }
  }

  #persist(
    eventType = "mailbox.updated",
    commandId = `mailbox:${eventType}:${randomUUID()}`,
    fileDeletions: string[] = [],
    rebaseHistory = false,
  ): void {
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
  if (!value) return "attachment";
  const extension = extname(value);
  if (!extension || extension.length >= 180) return value.slice(0, 180);
  const stem = value.slice(0, -extension.length);
  return `${stem.slice(0, 180 - extension.length)}${extension}`;
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
  const inferred = attachmentMimeTypeForName(name);
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

function assertSupportedAttachmentName(name: string): void {
  if (isSupportedAttachmentName(name)) return;
  throw new Error(`${name} is not supported. Attach ${SUPPORTED_ATTACHMENT_DESCRIPTION}.`);
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
    // `isStoredAttachment` accepts a persisted attachment with no `previewUrl` at all, from before
    // the field existed. `StoredAttachment extends AttachmentSummary` claims `string | null`, so
    // tsc cannot see the gap — and an `undefined` reaching the summary fails `isAttachmentSummary`
    // at the IPC boundary, which would take the whole conversation down with it.
    previewUrl: attachment.previewUrl ?? null,
  };
}

function normalizeBytes(value: Uint8Array): Uint8Array {
  if (value instanceof Uint8Array) return value;
  throw new Error("Attachment data is invalid.");
}

function normalizeStoredState(value: StoredState): StoredState {
  const nextOrderByAgent = new Map<string, number>();
  const deliveries = value.deliveries.map((delivery) => {
    const fallback = nextOrderByAgent.get(delivery.recipientAgentId) ?? 0;
    const queueOrder = Number.isFinite(delivery.queueOrder) ? delivery.queueOrder : fallback;
    nextOrderByAgent.set(delivery.recipientAgentId, Math.max(fallback, queueOrder + 1));
    return { ...delivery, queueOrder };
  });
  return {
    ...value,
    version: 3,
    generatedAttachments: value.generatedAttachments ?? [],
    deliveries,
    reactions: value.reactions.map((reaction) => ({
      ...reaction,
      actor: reaction.actor ?? { kind: "user" },
    })),
  };
}

function compareQueueOrder(left: StoredDelivery, right: StoredDelivery): number {
  return (
    left.queueOrder - right.queueOrder ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

/**
 * Mailbox state written before the bot-to-agent rename spells the product agent `bot`. The validators
 * below run *before* normalization and throw "Stored mailbox projection is invalid.", so an old
 * spelling does not degrade -- it blocks startup outright. Migration v13 rewrites the database, but a
 * user who restores `openbot.db` from their own copy of the file never runs it, and `mailbox.json`
 * predates the database entirely. So every read tolerates both spellings and every write emits only
 * the new one. This renames keys and the `sender.kind` / `actor.kind` discriminant, never message text.
 */
function toCurrentMailboxState(value: unknown): DynamicRecord | null {
  if (!isRecord(value)) return null;
  const state = withCurrentAgentKeys(value, { pausedBotIds: "pausedAgentIds" });
  return {
    ...state,
    ...(Array.isArray(state.messages) ? { messages: state.messages.map(toCurrentMailboxMessage) } : {}),
    ...(Array.isArray(state.deliveries) ? { deliveries: state.deliveries.map(toCurrentDelivery) } : {}),
    ...(Array.isArray(state.generatedAttachments)
      ? { generatedAttachments: state.generatedAttachments.map(toCurrentGeneratedAttachment) }
      : {}),
    ...(Array.isArray(state.reactions) ? { reactions: state.reactions.map(toCurrentMailboxReaction) } : {}),
  };
}

const ACTOR_AGENT_KEYS: Readonly<Record<string, string>> = { botId: "agentId" };

function toCurrentDelivery(value: unknown): DynamicRecord | null {
  return isRecord(value) ? withCurrentAgentKeys(value, { recipientBotId: "recipientAgentId" }) : null;
}

function toCurrentGeneratedAttachment(value: unknown): DynamicRecord | null {
  return isRecord(value) ? withCurrentAgentKeys(value, { ownerBotId: "ownerAgentId" }) : null;
}

function toCurrentMailboxMessage(value: unknown): DynamicRecord | null {
  return isRecord(value) ? { ...value, sender: toCurrentMailboxActor(value.sender) } : null;
}

function toCurrentMailboxReaction(value: unknown): DynamicRecord | null {
  if (!isRecord(value)) return null;
  const reaction = withCurrentAgentKeys(value, ACTOR_AGENT_KEYS);
  return reaction.actor === undefined ? reaction : { ...reaction, actor: toCurrentMailboxActor(reaction.actor) };
}

function toCurrentMailboxActor(value: unknown): DynamicRecord | null {
  if (!isRecord(value)) return null;
  const actor = withCurrentAgentKeys(value, ACTOR_AGENT_KEYS);
  return actor.kind === "bot" ? { ...actor, kind: "agent" } : actor;
}

/**
 * Rewrites the legacy keys onto their current names, dropping a legacy key whose current name is
 * already present so a half-migrated record cannot resurrect a stale value.
 */
function withCurrentAgentKeys(value: DynamicRecord, renames: Readonly<Record<string, string>>): DynamicRecord {
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      const current = renames[key];
      if (current === undefined) return [[key, entry]];
      return value[current] === undefined ? [[current, entry]] : [];
    }),
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
    Array.isArray(value.pausedAgentIds) &&
    value.pausedAgentIds.every((item) => isString(item)) &&
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
    (value.ownerAgentId === undefined || isString(value.ownerAgentId)) &&
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
      (value.sender.kind === "agent" && isString(value.sender.agentId)) ||
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
    isString(value.recipientAgentId) &&
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
    isString(value.agentId) &&
    isString(value.messageId) &&
    isMessageReaction(value.emoji) &&
    (value.actor === undefined || isStoredReactionActor(value.actor)) &&
    isString(value.updatedAt)
  );
}

function isStoredReactionActor(value: unknown): value is ConversationReactionActor {
  return (
    isRecord(value) &&
    (value.kind === "user" || (value.kind === "agent" && isString(value.agentId) && value.agentId.length > 0))
  );
}

function reactionActorsEqual(left: ConversationReactionActor, right: ConversationReactionActor): boolean {
  return (
    left.kind === right.kind && (left.kind === "user" || (right.kind === "agent" && left.agentId === right.agentId))
  );
}

function compareReactionActors(left: ConversationReaction, right: ConversationReaction): number {
  if (left.actor.kind !== right.actor.kind) return left.actor.kind === "user" ? -1 : 1;
  if (left.actor.kind === "user" || right.actor.kind === "user") return 0;
  return left.actor.agentId.localeCompare(right.actor.agentId);
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

async function copyOpenedFile(
  source: FileHandle,
  targetPath: string,
  name: string,
  remainingTotalBytes: number,
): Promise<void> {
  const target = await open(targetPath, "wx", 0o600);
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  try {
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) return;
      const nextPosition = position + bytesRead;
      if (nextPosition > MAX_FILE_BYTES) throw new Error(`${name} exceeds the 100 MB limit.`);
      if (nextPosition > remainingTotalBytes) throw new Error("Attachments exceed the 250 MB total limit.");

      let written = 0;
      while (written < bytesRead) {
        const result = await target.write(buffer, written, bytesRead - written, position + written);
        if (result.bytesWritten === 0) throw new Error(`OpenBot could not copy ${name}.`);
        written += result.bytesWritten;
      }
      position = nextPosition;
    }
  } finally {
    await target.close();
  }
}
