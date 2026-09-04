import type { ImageGenerationInfo } from "@openbot/contracts/ipc";
import { isString } from "@openbot/contracts/runtime-values";
import { newAssistantMessage } from "../conversation-snapshots";
import type { MailboxStore } from "../mailbox-store";
import { getString, type ThreadItem } from "../protocol";
import type { ConversationRuntime } from "./conversation-runtime";
import { lastUserPrompt } from "./delivery-content";
import {
  decodeGeneratedImage,
  generatedImageName,
  imageGenerationAspectRatio,
  imageGenerationFailure,
  isImageGenerationItem,
} from "./image-generation";

interface ImageGenerationOperation {
  interrupted: boolean;
  promise: Promise<void> | null;
}

export interface ImageGenHooks {
  /** Mirrors the facade's itemId → turnId index used by turn completion. */
  trackItem(itemId: string, turnId: string): void;
}

export interface ImageGenRuntimeOptions {
  conversation: ConversationRuntime;
  mailbox: MailboxStore;
  hooks: ImageGenHooks;
}

/**
 * Streaming image-generation items, and the interrupt flag that races them.
 *
 * Owns the `threadId:turnId:itemId` operation map plus the `threadId:turnId`
 * interrupted set. Everything else (snapshots, attachments, events) goes
 * through the injected conversation/mailbox, so this class never imports the
 * facade. The facade keeps `#itemTurns` — it is shared with plain agent
 * messages and deltas — and only receives updates via `trackItem`.
 */
export class ImageGenRuntime {
  readonly #conversation: ConversationRuntime;
  readonly #mailbox: MailboxStore;
  readonly #hooks: ImageGenHooks;
  readonly #operations = new Map<string, ImageGenerationOperation>();
  readonly #interruptedTurns = new Set<string>();

  constructor(options: ImageGenRuntimeOptions) {
    this.#conversation = options.conversation;
    this.#mailbox = options.mailbox;
    this.#hooks = options.hooks;
  }

  /**
   * Handles one streaming item when it is an image-generation item.
   * Returns true when handled, so the caller can fall through for the rest.
   */
  handleItem(botId: string, threadId: string, turnId: string, item: ThreadItem, completed: boolean): boolean {
    if (!isImageGenerationItem(item)) return false;
    const operationKey = `${threadId}:${turnId}:${item.id}`;
    const state = this.#operations.get(operationKey) ?? {
      interrupted: this.#interruptedTurns.has(`${threadId}:${turnId}`),
      promise: null,
    };
    state.interrupted ||= this.#interruptedTurns.has(`${threadId}:${turnId}`);
    this.#operations.set(operationKey, state);
    state.promise = this.#applyImageGenerationItem(botId, threadId, turnId, item, completed, state);
    return true;
  }

  interrupt(botId: string, threadId: string, turnId: string): void {
    this.#interruptedTurns.add(`${threadId}:${turnId}`);
    for (const [key, operation] of this.#operations) {
      if (!key.startsWith(`${threadId}:${turnId}:`)) continue;
      operation.interrupted = true;
    }
    const snapshot = this.#conversation.ensureSnapshot(botId, threadId);
    let changed = false;
    for (const message of snapshot.messages) {
      if (
        message.turnId !== turnId ||
        message.itemType !== "image_generation" ||
        message.status === "completed" ||
        message.status === "failed" ||
        message.status === "interrupted"
      ) {
        continue;
      }
      message.status = "interrupted";
      if (message.imageGeneration) message.imageGeneration.error ??= "Image generation was interrupted.";
      changed = true;
    }
    if (changed) this.#conversation.emitConversation(snapshot, "image-generation.interrupted", { turnId });
  }

  async waitForOperations(threadId: string, turnId: string): Promise<void> {
    const entries = [...this.#operations.entries()].filter(([key]) => key.startsWith(`${threadId}:${turnId}:`));
    const operations = entries
      .map(([, operation]) => operation.promise)
      .filter((promise): promise is Promise<void> => promise !== null);
    if (operations.length > 0) await Promise.allSettled(operations);
    for (const [key] of entries) {
      if (this.#operations.has(key)) this.#operations.delete(key);
    }
    this.#interruptedTurns.delete(`${threadId}:${turnId}`);
  }

  /** Promises the facade awaits during stop() before clearing. */
  pendingPromises(): Promise<void>[] {
    return [...this.#operations.values()]
      .map((operation) => operation.promise)
      .filter((promise): promise is Promise<void> => promise !== null);
  }

  dispose(): void {
    this.#operations.clear();
    this.#interruptedTurns.clear();
  }

  async #applyImageGenerationItem(
    botId: string,
    threadId: string,
    turnId: string,
    item: ThreadItem,
    completed: boolean,
    operation: ImageGenerationOperation,
  ): Promise<void> {
    if (!isString(item.id)) return;
    const snapshot = this.#conversation.ensureSnapshot(botId, threadId);
    let message = snapshot.messages.find((candidate) => candidate.id === item.id);
    if (!message) {
      message = newAssistantMessage(item.id, turnId);
      snapshot.messages.push(message);
    }

    const previous = message.imageGeneration;
    const prompt =
      getString(item, "revised_prompt") ??
      getString(item, "prompt") ??
      previous?.prompt ??
      lastUserPrompt(snapshot) ??
      undefined;
    const resolution =
      getString(item, "resolution") ?? getString(item, "size") ?? previous?.resolution ?? "1024 × 1024";
    const aspectRatio = imageGenerationAspectRatio(item) ?? previous?.aspectRatio ?? "square";
    const providerStatus = getString(item, "status");
    const failure = imageGenerationFailure(item);

    message.itemType = "image_generation";
    message.text = "";
    message.imageGeneration = {
      prompt,
      resolution,
      aspectRatio,
      ...(failure ? { error: failure } : {}),
    } satisfies ImageGenerationInfo;
    message.status = operation.interrupted ? "interrupted" : completed ? "completed" : "streaming";
    this.#hooks.trackItem(item.id, turnId);
    this.#conversation.emitConversation(snapshot);

    if (!completed || operation.interrupted) {
      if (operation.interrupted) message.imageGeneration.error ??= "Image generation was interrupted.";
      return;
    }
    if (providerStatus === "failed" || failure) {
      message.status = "failed";
      message.imageGeneration.error = failure ?? "Image generation failed.";
      this.#conversation.emitConversation(snapshot);
      return;
    }

    const savedPath = getString(item, "saved_path");
    const result = getString(item, "result");
    try {
      let attachment: Awaited<ReturnType<MailboxStore["storeGeneratedAttachment"]>>;
      if (savedPath) {
        try {
          attachment = await this.#mailbox.storeGeneratedAttachment({
            sourcePath: savedPath,
            name: generatedImageName(savedPath),
            ownerBotId: botId,
            ownerThreadId: threadId,
          });
        } catch (error) {
          if (!result) throw error;
          attachment = await this.#mailbox.storeGeneratedAttachment({
            bytes: decodeGeneratedImage(result),
            name: "generated-image.png",
            mimeType: "image/png",
            ownerBotId: botId,
            ownerThreadId: threadId,
          });
        }
      } else if (result) {
        attachment = await this.#mailbox.storeGeneratedAttachment({
          bytes: decodeGeneratedImage(result),
          name: "generated-image.png",
          mimeType: "image/png",
          ownerBotId: botId,
          ownerThreadId: threadId,
        });
      } else {
        throw new Error("Image generation did not return an image.");
      }
      if (operation.interrupted) {
        const interruptedSnapshot = this.#conversation.ensureSnapshot(botId, threadId);
        const interruptedMessage = interruptedSnapshot.messages.find((candidate) => candidate.id === item.id);
        if (interruptedMessage?.imageGeneration) {
          interruptedMessage.status = "interrupted";
          interruptedMessage.imageGeneration.error ??= "Image generation was interrupted.";
          this.#conversation.emitConversation(interruptedSnapshot);
        }
        return;
      }
      const latestSnapshot = this.#conversation.ensureSnapshot(botId, threadId);
      const latestMessage = latestSnapshot.messages.find((candidate) => candidate.id === item.id);
      if (!latestMessage?.imageGeneration) return;
      latestMessage.attachments = [attachment];
      latestMessage.status = "completed";
      delete latestMessage.imageGeneration.error;
      this.#conversation.emitConversation(latestSnapshot);
      return;
    } catch (error) {
      const latestSnapshot = this.#conversation.ensureSnapshot(botId, threadId);
      const latestMessage = latestSnapshot.messages.find((candidate) => candidate.id === item.id);
      if (!latestMessage?.imageGeneration) return;
      latestMessage.status = "failed";
      latestMessage.imageGeneration.error = error instanceof Error ? error.message : String(error);
      this.#conversation.emitConversation(latestSnapshot);
    }
  }
}
