export type ChatTagKind = "agent" | "skill";

export interface ChatTagReference {
  kind: ChatTagKind;
  id: string;
  name: string;
  start: number;
  end: number;
}

const CHAT_TAG_REFERENCE_PATTERN = /@\[([^\]\r\n]+)\]\((agent|skill)(\+uri)?:([^)\r\n]+)\)/gu;

export function serializeChatTagReference(kind: ChatTagKind, name: string, id: string): string {
  if (name && id && !/[\]\r\n]/u.test(name) && !/[)\r\n]/u.test(id)) return `@[${name}](${kind}:${id})`;
  return `@[${encodeChatTagComponent(name)}](${kind}+uri:${encodeChatTagComponent(id)})`;
}

export function chatTagReferences(value: string): ChatTagReference[] {
  return [...value.matchAll(CHAT_TAG_REFERENCE_PATTERN)].map((match) => ({
    kind: chatTagKind(match[2]),
    id: decodeChatTagComponent(match[4] ?? "", match[3] !== undefined),
    name: decodeChatTagComponent(match[1] ?? "", match[3] !== undefined),
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
    (
      marker,
      encodedName: string,
      kind: ChatTagKind,
      encoding: string | undefined,
      encodedId: string,
      offset: number,
    ) => {
      const name = decodeChatTagComponent(encodedName, encoding !== undefined);
      const id = decodeChatTagComponent(encodedId, encoding !== undefined);
      const reference = { kind, id, name, start: offset, end: offset + marker.length };
      const resolvedName = resolveName?.(reference) ?? name;
      return kind === "agent" ? `@${resolvedName}` : `${resolvedName} (skill)`;
    },
  );
}

function encodeChatTagComponent(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function decodeChatTagComponent(value: string, encoded: boolean): string {
  if (!encoded) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
