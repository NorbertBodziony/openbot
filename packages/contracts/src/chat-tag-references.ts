export type ChatTagKind = "agent" | "skill";

export interface ChatTagReference {
  kind: ChatTagKind;
  id: string;
  name: string;
  start: number;
  end: number;
}

const CHAT_TAG_REFERENCE_PATTERN = /@\[([^\]\r\n]+)\]\((agent|skill):([^)\r\n]+)\)/gu;

export function serializeChatTagReference(kind: ChatTagKind, name: string, id: string): string {
  const safeName = name.replace(/[\]\r\n]/gu, "").trim();
  const safeId = id.replace(/[)\r\n]/gu, "").trim();
  return `@[${safeName}](${kind}:${safeId})`;
}

export function chatTagReferences(value: string): ChatTagReference[] {
  return [...value.matchAll(CHAT_TAG_REFERENCE_PATTERN)].map((match) => ({
    kind: chatTagKind(match[2]),
    id: match[3] ?? "",
    name: match[1] ?? "",
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
}

function chatTagKind(value: string | undefined): ChatTagKind {
  return value === "skill" ? "skill" : "agent";
}

export function expandChatTagReferences(
  value: string,
  resolveName?: (reference: ChatTagReference) => string | undefined,
): string {
  return value.replace(
    CHAT_TAG_REFERENCE_PATTERN,
    (marker, name: string, kind: ChatTagKind, id: string, offset: number) => {
      const reference = { kind, id, name, start: offset, end: offset + marker.length };
      const resolvedName = resolveName?.(reference) ?? name;
      return kind === "agent" ? `@${resolvedName}` : `${resolvedName} (skill)`;
    },
  );
}
