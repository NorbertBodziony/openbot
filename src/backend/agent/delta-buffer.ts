export const DELTA_FLUSH_BYTES = 8 * 1024;

export interface DeltaInput {
  botId: string;
  externalThreadId: string;
  publicThreadId: string;
  turnId: string;
  messageId: string;
  text: string;
  createdAt: string;
}

export function deltaKey(delta: Pick<DeltaInput, "externalThreadId" | "turnId" | "messageId">): string {
  return `${delta.externalThreadId}:${delta.turnId}:${delta.messageId}`;
}

export function appendDeltaText(currentText: string, nextText: string): { text: string; shouldFlush: boolean } {
  const text = currentText + nextText;
  return { text, shouldFlush: Buffer.byteLength(text, "utf8") >= DELTA_FLUSH_BYTES };
}

export function shouldFlushDeltaText(text: string): boolean {
  return Buffer.byteLength(text, "utf8") >= DELTA_FLUSH_BYTES;
}
