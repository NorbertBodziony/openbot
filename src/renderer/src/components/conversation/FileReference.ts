import { attachmentReferences } from "@openbot/contracts/attachment-references";
import type { AttachmentSummary } from "@openbot/contracts/ipc";

export type MessageFileReference =
  | {
      kind: "attachment";
      attachment: AttachmentSummary;
      name: string;
      start: number;
      end: number;
    }
  | {
      kind: "shared";
      path: string;
      name: string;
      start: number;
      end: number;
    };

interface TextRange {
  start: number;
  end: number;
}

const PATH_CHARACTER_EXCLUSIONS = "\\s\"'`<>()[\\]";
const UNQUOTED_PATH_PATTERNS = [
  new RegExp(`~[/\\\\][^${PATH_CHARACTER_EXCLUSIONS}]+`, "gu"),
  new RegExp(`[A-Za-z]:[/\\\\][^${PATH_CHARACTER_EXCLUSIONS}]+`, "gu"),
  new RegExp(`[/\\\\][^${PATH_CHARACTER_EXCLUSIONS}]+`, "gu"),
  /(?:^|[\s"'`([{])((?:OpenBot[/\\])?Shared[/\\][^\s"'`<>()[\]]+)/gu,
];
const QUOTED_PATH_PATTERN = /(["'`])([^"'`\r\n]+)\1/gu;
const FILENAME_CHARACTER_PATTERN = /[\p{L}\p{N}_.-]/u;
const URL_PREFIX_PATTERN = /^(?:(?:https?:)?\/\/|[A-Za-z]:\/\/)/iu;

export function messageFileReferences(body: string, attachments: AttachmentSummary[] = []): MessageFileReference[] {
  const references: MessageFileReference[] = [];
  const occupied: TextRange[] = [];
  const attachmentsById = new Map(attachments.map((attachment) => [attachment.id, attachment]));

  for (const reference of attachmentReferences(body)) {
    occupied.push(reference);
    const attachment = attachmentsById.get(reference.attachmentId);
    if (!attachment) continue;
    references.push({
      kind: "attachment",
      attachment,
      name: attachment.name,
      start: reference.start,
      end: reference.end,
    });
  }

  for (const candidate of sharedPathCandidates(body)) {
    if (occupied.some((range) => rangesOverlap(range, candidate))) continue;
    const candidatePath = body.slice(candidate.start, candidate.end);
    if (!isSharedFilePath(candidatePath)) continue;
    const attachment = attachmentForPath(candidatePath, attachments);
    const reference: MessageFileReference = attachment
      ? {
          kind: "attachment",
          attachment,
          name: attachment.name,
          start: candidate.start,
          end: candidate.end,
        }
      : {
          kind: "shared",
          path: candidatePath,
          name: fileName(candidatePath),
          start: candidate.start,
          end: candidate.end,
        };
    references.push(reference);
    occupied.push(candidate);
  }

  const sortedAttachments = [...attachments].sort((left, right) => right.name.length - left.name.length);
  for (const attachment of sortedAttachments) {
    let searchStart = 0;
    while (searchStart < body.length) {
      const index = body.indexOf(attachment.name, searchStart);
      if (index < 0) break;
      const end = index + attachment.name.length;
      searchStart = end;
      if (!isFilenameMatch(body, index, end)) continue;

      const range = attachmentPathRange(body, index, end);
      if (!range) continue;
      if (occupied.some((candidate) => rangesOverlap(candidate, range))) continue;
      references.push({
        kind: "attachment",
        attachment,
        name: attachment.name,
        start: range.start,
        end: range.end,
      });
      occupied.push(range);
    }
  }

  return references.sort((left, right) => left.start - right.start || left.end - right.end);
}

export function referencedAttachmentIds(body: string, attachments: AttachmentSummary[] = []): Set<string> {
  return new Set(
    messageFileReferences(body, attachments)
      .filter((reference): reference is Extract<MessageFileReference, { kind: "attachment" }> => {
        return reference.kind === "attachment";
      })
      .map((reference) => reference.attachment.id),
  );
}

export function isSharedFilePath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  if (segments[0] === "Shared" && segments.length > 1) return true;
  return segments.some((segment, index) => segment === "OpenBot" && segments[index + 1] === "Shared");
}

function sharedPathCandidates(body: string): TextRange[] {
  const ranges: TextRange[] = [];
  const seen = new Set<string>();
  const add = (start: number, rawValue: string) => {
    const value = trimPathPunctuation(rawValue);
    if (!value || URL_PREFIX_PATTERN.test(value) || !isSharedFilePath(value)) return;
    const end = start + value.length;
    const key = `${start}:${end}`;
    if (seen.has(key)) return;
    seen.add(key);
    ranges.push({ start, end });
  };

  for (const match of body.matchAll(QUOTED_PATH_PATTERN)) {
    const value = match[2] ?? "";
    const start = (match.index ?? 0) + (match[0]?.indexOf(value) ?? 0);
    add(start, value);
  }

  for (const expression of UNQUOTED_PATH_PATTERNS) {
    for (const match of body.matchAll(expression)) {
      const value = match[1] ?? match[0] ?? "";
      const offset = match[1] ? (match[0]?.indexOf(value) ?? 0) : 0;
      add((match.index ?? 0) + offset, value);
    }
  }

  return ranges.sort((left, right) => left.start - right.start || right.end - left.end);
}

function attachmentForPath(path: string, attachments: AttachmentSummary[]): AttachmentSummary | undefined {
  const name = fileName(path);
  return attachments.find((attachment) => attachment.name === name);
}

function fileName(path: string): string {
  return path.replaceAll("\\", "/").split("/").at(-1) || "Shared file";
}

function attachmentPathRange(body: string, start: number, end: number): TextRange | null {
  let rangeStart = start;
  while (rangeStart > 0 && !isPathBoundary(body[rangeStart - 1])) rangeStart -= 1;
  const candidate = body.slice(rangeStart, end);
  if (candidate.includes("/") || candidate.includes("\\")) {
    if (URL_PREFIX_PATTERN.test(candidate)) return null;
    return { start: rangeStart, end };
  }
  return { start, end };
}

function isPathBoundary(value: string | undefined): boolean {
  return value === undefined || value === "[" || value === "]" || /[\s"'`(){}<>]/u.test(value);
}

function isFilenameMatch(body: string, start: number, end: number): boolean {
  const previous = body[start - 1];
  const next = body[end];
  if (isFilenameCharacter(previous)) return false;
  if (next !== ".") return !isFilenameCharacter(next);
  const following = body[end + 1];
  return following === undefined || following === "." || !isFilenameCharacter(following);
}

function isFilenameCharacter(value: string | undefined): boolean {
  return value !== undefined && FILENAME_CHARACTER_PATTERN.test(value);
}

function trimPathPunctuation(value: string): string {
  let result = value;
  while (/[.,!?;:)}\]]/u.test(result.at(-1) ?? "")) result = result.slice(0, -1);
  return result;
}

function rangesOverlap(left: TextRange, right: TextRange): boolean {
  return left.start < right.end && right.start < left.end;
}
