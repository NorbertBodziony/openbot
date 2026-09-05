const COMPLETE_INTERNAL_CITATION = /\u{e200}cite(?:\u{e202}[^\u{e201}]*)?\u{e201}/gu;
const STREAMING_INTERNAL_CITATION = /\u{e200}(?:c(?:i(?:t(?:e(?:\u{e202}[^\u{e201}]*)?)?)?)?)?$/u;

export function cleanAgentMessageText(text: string): string {
  return text.replace(COMPLETE_INTERNAL_CITATION, "").replace(STREAMING_INTERNAL_CITATION, "");
}
