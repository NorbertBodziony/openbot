import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import {
  attachmentFileExtension,
  attachmentMimeTypeForName,
  isSupportedAttachmentImportName,
  isSupportedAttachmentName,
  SUPPORTED_ATTACHMENT_IMPORT_DESCRIPTION,
} from "@openbot/contracts/attachment-files";
import { ATTACHMENT_LIMITS, INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { AttachmentDataInput, ImportAttachmentsInput } from "@openbot/contracts/ipc";
import PostalMime from "postal-mime";

const EMAIL_MAX_HEADERS_BYTES = 2 * 1024 * 1024;
const EMAIL_MAX_NESTING_DEPTH = 32;
const EMAIL_MAX_RFC822_NESTING_DEPTH = 10;
const EMAIL_MAX_MIME_PARTS = 64;
const HEADER_DECODER = new TextDecoder("latin1");
interface AttachmentBudget {
  count: number;
  bytes: number;
}

export async function normalizeAttachmentImports(input: ImportAttachmentsInput): Promise<ImportAttachmentsInput> {
  if (input.paths.length + input.data.length === 0) return { paths: [], data: [] };
  if (input.paths.length + input.data.length > INPUT_LIMITS.attachments) {
    throw new Error(`Choose at most ${INPUT_LIMITS.attachments} files.`);
  }

  const paths: string[] = [];
  const data: AttachmentDataInput[] = [];
  let leafCount = 0;
  let leafBytes = 0;
  for (const path of input.paths) {
    const name = basename(path);
    assertSupportedImport(name);
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error(`Only regular files can be attached: ${name}`);
    if (metadata.size > ATTACHMENT_LIMITS.fileBytes) throw new Error(`${name} exceeds the 100 MB limit.`);
    if (isEmailImport(name)) continue;
    paths.push(path);
    leafCount += 1;
    leafBytes += metadata.size;
  }
  for (const item of input.data) {
    const name = basename(item.name);
    assertSupportedImport(name);
    if (isEmailImport(name)) continue;
    if (item.bytes.byteLength > ATTACHMENT_LIMITS.fileBytes) throw new Error(`${name} exceeds the 100 MB limit.`);
    leafCount += 1;
    leafBytes += item.bytes.byteLength;
  }
  if (leafBytes > ATTACHMENT_LIMITS.totalBytes) throw new Error("Attachments exceed the 250 MB total limit.");

  const budget: AttachmentBudget = {
    count: INPUT_LIMITS.attachments - leafCount,
    bytes: ATTACHMENT_LIMITS.totalBytes - leafBytes,
  };
  for (const path of input.paths) {
    const name = basename(path);
    if (!isEmailImport(name)) continue;
    const expanded = await expandEmailWithinBudget(name, new Uint8Array(await readFile(path)), budget);
    data.push(...expanded);
    consumeBudget(budget, expanded);
  }
  for (const item of input.data) {
    const name = basename(item.name);
    if (isEmailImport(name)) {
      const expanded = await expandEmailWithinBudget(name, item.bytes, budget);
      data.push(...expanded);
      consumeBudget(budget, expanded);
    } else {
      data.push({ name, mimeType: item.mimeType, bytes: item.bytes });
    }
  }

  await assertExpandedLimits(paths, data);
  return { paths, data };
}

function isEmailImport(name: string): boolean {
  return attachmentFileExtension(name) === "eml";
}

function assertSupportedImport(name: string): void {
  if (isSupportedAttachmentImportName(name)) return;
  throw new Error(`${name || "This file"} is not supported. Attach ${SUPPORTED_ATTACHMENT_IMPORT_DESCRIPTION}.`);
}

async function expandEmailWithinBudget(
  name: string,
  bytes: Uint8Array,
  budget: AttachmentBudget,
): Promise<AttachmentDataInput[]> {
  if (bytes.byteLength > ATTACHMENT_LIMITS.fileBytes) throw new Error(`${name} exceeds the 100 MB limit.`);
  const expanded = await expandEmail(name, bytes, budget);
  assertWithinBudget(expanded, budget);
  return expanded;
}

async function expandEmail(name: string, bytes: Uint8Array, budget: AttachmentBudget): Promise<AttachmentDataInput[]> {
  assertEmailPreflight(name, bytes, budget);
  let email: Awaited<ReturnType<typeof PostalMime.parse>>;
  try {
    email = await PostalMime.parse(bytes, {
      attachmentEncoding: "arraybuffer",
      maxHeadersSize: EMAIL_MAX_HEADERS_BYTES,
      maxNestingDepth: EMAIL_MAX_NESTING_DEPTH,
      maxRfc822NestingDepth: EMAIL_MAX_RFC822_NESTING_DEPTH,
      rfc822Attachments: true,
    });
  } catch {
    throw new Error(`${name} is malformed or exceeds safe email parsing limits. Export it again and retry.`);
  }
  if (email.headers.length === 0 && !email.text?.trim() && !email.html?.trim() && email.attachments.length === 0) {
    throw new Error(`${name} does not contain a recognizable email message. Export it as EML and retry.`);
  }

  const stem = safeStem(name);
  const summary = [
    email.headers.map((header) => `${header.originalKey}: ${header.value}`).join("\n"),
    email.text?.trim() || (email.html?.trim() ? "The email body is available in the accompanying HTML file." : ""),
  ]
    .filter(Boolean)
    .join("\n\n");
  const result: AttachmentDataInput[] = [textAttachment(`${stem} - email.txt`, summary)];
  if (email.html?.trim()) result.push(textAttachment(`${stem} - email.html`, email.html, "text/html"));

  const usedNames = new Set(result.map((item) => item.name));
  for (const [index, attachment] of email.attachments.entries()) {
    const sourceName = attachment.filename?.trim() || fallbackAttachmentName(attachment.mimeType, index + 1);
    assertSafeMemberName(name, sourceName);
    assertLeafEntry(name, sourceName);
    const outputName = uniqueName(flattenedName(stem, sourceName), usedNames);
    result.push({
      name: outputName,
      mimeType: attachmentMimeTypeForName(outputName),
      bytes: attachmentBytes(attachment.content, attachment.encoding),
    });
  }
  return result;
}

function assertWithinBudget(items: AttachmentDataInput[], budget: AttachmentBudget): void {
  if (items.length > budget.count) {
    throw new Error(`These files expand to more than ${INPUT_LIMITS.attachments} attachments. Import fewer files.`);
  }
  const total = items.reduce((sum, item) => sum + item.bytes.byteLength, 0);
  if (total > budget.bytes) throw new Error("Attachments exceed the 250 MB total limit.");
}

function consumeBudget(budget: AttachmentBudget, items: AttachmentDataInput[]): void {
  budget.count -= items.length;
  budget.bytes -= items.reduce((sum, item) => sum + item.bytes.byteLength, 0);
}

interface EmailHeaders {
  contentType: string;
  contentDisposition: string;
  bodyOffset: number;
  recognized: boolean;
}

function assertEmailPreflight(name: string, bytes: Uint8Array, budget: AttachmentBudget): void {
  let parts = 0;
  let attachments = 1;
  let hasHtml = false;
  const root = readEmailHeaders(bytes, 0);
  ({ parts, attachments, hasHtml } = countEmailPart(root, parts, attachments, hasHtml));
  assertEmailCounts(name, budget, parts, attachments);
  const boundaries = new Set<string>();
  addEmailBoundary(name, root, boundaries);
  let offset = root.bodyOffset;

  while (offset < bytes.byteLength) {
    const line = readEmailLine(bytes, offset);
    offset = line.nextOffset;
    const boundary = matchEmailBoundary(bytes, line, boundaries);
    if (!boundary) continue;
    if (boundary.closing) {
      boundaries.delete(boundary.value);
      continue;
    }
    const headers = readEmailHeaders(bytes, offset);
    ({ parts, attachments, hasHtml } = countEmailPart(headers, parts, attachments, hasHtml));
    assertEmailCounts(name, budget, parts, attachments);
    addEmailBoundary(name, headers, boundaries);
    offset = headers.bodyOffset;

    if (emailContentType(headers) === "message/rfc822" && emailDisposition(headers) === "inline") {
      const nested = readEmailHeaders(bytes, offset);
      ({ parts, attachments, hasHtml } = countEmailPart(nested, parts, attachments, hasHtml));
      assertEmailCounts(name, budget, parts, attachments);
      addEmailBoundary(name, nested, boundaries);
      offset = nested.bodyOffset;
    }
  }
}

function addEmailBoundary(name: string, headers: EmailHeaders, boundaries: Set<string>): void {
  if (/(?:^|;)\s*boundary\*(?:\d+\*?)?\s*=/iu.test(headers.contentType)) {
    throw new Error(`${name} uses an extended or continued MIME boundary, which is not supported. Export it again.`);
  }
  const match = /(?:^|;)\s*boundary\s*=\s*(?:"((?:\\.|[^"])*)"|([^;\s]+))/iu.exec(headers.contentType);
  const boundary = (match?.[1] ?? match?.[2])?.replace(/\\(.)/gu, "$1");
  if (boundary) boundaries.add(boundary);
}

function matchEmailBoundary(
  bytes: Uint8Array,
  line: ReturnType<typeof readEmailLine>,
  boundaries: Set<string>,
): { value: string; closing: boolean } | null {
  if (bytes[line.startOffset] !== 45 || bytes[line.startOffset + 1] !== 45) return null;
  const candidate = HEADER_DECODER.decode(bytes.subarray(line.startOffset + 2, line.endOffset)).trimEnd();
  if (boundaries.has(candidate)) return { value: candidate, closing: false };
  const closing = candidate.endsWith("--") ? candidate.slice(0, -2) : "";
  if (closing && boundaries.has(closing)) return { value: closing, closing: true };
  return null;
}

function assertEmailCounts(name: string, budget: AttachmentBudget, parts: number, attachments: number): void {
  if (parts > EMAIL_MAX_MIME_PARTS) {
    throw new Error(`${name} contains too many MIME parts. Remove attachments and retry.`);
  }
  if (attachments > budget.count) {
    throw new Error(`These files expand to more than ${INPUT_LIMITS.attachments} attachments. Import fewer files.`);
  }
}

function countEmailPart(
  headers: EmailHeaders,
  parts: number,
  attachments: number,
  hasHtml: boolean,
): { parts: number; attachments: number; hasHtml: boolean } {
  if (!headers.recognized) return { parts: parts + 1, attachments, hasHtml };
  const contentType = emailContentType(headers);
  const disposition = emailDisposition(headers);
  const named = hasEmailAttachmentName(headers);
  const isAttachment =
    named ||
    disposition === "attachment" ||
    (contentType !== "" &&
      contentType !== "text/plain" &&
      contentType !== "text/html" &&
      !contentType.startsWith("multipart/") &&
      !(contentType === "message/rfc822" && disposition === "inline"));
  const isHtml = contentType === "text/html" && !isAttachment;
  return {
    parts: parts + 1,
    attachments: attachments + Number(isHtml && !hasHtml) + Number(isAttachment),
    hasHtml: hasHtml || isHtml,
  };
}

function emailContentType(headers: EmailHeaders): string {
  return headers.contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function emailDisposition(headers: EmailHeaders): string {
  return (
    headers.contentDisposition
      .trim()
      .toLowerCase()
      .match(/^[a-z]+/u)?.[0] ?? ""
  );
}

function hasEmailAttachmentName(headers: EmailHeaders): boolean {
  const contentName = /(?:^|;)\s*name\s*=\s*(?:"((?:\\.|[^"])*)"|([^;\s]+))/iu.exec(headers.contentType);
  const dispositionFilename = /(?:^|;)\s*filename\s*=\s*(?:"((?:\\.|[^"])*)"|([^;\s]+))/iu.exec(
    headers.contentDisposition,
  );
  return [contentName, dispositionFilename].some((match) => {
    const value = (match?.[1] ?? match?.[2])?.replace(/\\(.)/gu, "$1");
    return Boolean(value?.trim());
  });
}

function readEmailHeaders(bytes: Uint8Array, startOffset: number): EmailHeaders {
  let contentType = "";
  let contentDisposition = "";
  let current: "content-type" | "content-disposition" | null = null;
  let offset = startOffset;
  let recognized = false;

  while (offset < bytes.byteLength) {
    const line = readEmailLine(bytes, offset);
    if (line.nextOffset - startOffset > EMAIL_MAX_HEADERS_BYTES) {
      throw new Error("Email headers exceed the 2 MB limit. Export a smaller message and retry.");
    }
    offset = line.nextOffset;
    if (line.startOffset === line.endOffset) break;
    const value = HEADER_DECODER.decode(bytes.subarray(line.startOffset, line.endOffset));
    if (/^[\t ]/u.test(value)) {
      if (current === "content-type") contentType += ` ${value.trim()}`;
      else if (current === "content-disposition") contentDisposition += ` ${value.trim()}`;
      continue;
    }
    const separator = value.indexOf(":");
    if (separator < 1) {
      current = null;
      continue;
    }
    recognized = true;
    const key = value.slice(0, separator).trim().toLowerCase();
    current = key === "content-type" || key === "content-disposition" ? key : null;
    if (current === "content-type") {
      contentType = value.slice(separator + 1).trim();
    } else if (current === "content-disposition") {
      contentDisposition = value.slice(separator + 1).trim();
    }
  }

  return { contentType, contentDisposition, bodyOffset: offset, recognized };
}

function readEmailLine(
  bytes: Uint8Array,
  startOffset: number,
): { startOffset: number; endOffset: number; nextOffset: number } {
  let endOffset = startOffset;
  while (endOffset < bytes.byteLength && bytes[endOffset] !== 10 && bytes[endOffset] !== 13) endOffset += 1;
  let nextOffset = endOffset;
  if (bytes[nextOffset] === 13) nextOffset += 1;
  if (bytes[nextOffset] === 10) nextOffset += 1;
  return { startOffset, endOffset, nextOffset };
}

function assertSafeMemberName(container: string, name: string): void {
  const parts = name.split("/");
  if (
    !name ||
    name.includes("\0") ||
    name.includes("\\") ||
    name.startsWith("/") ||
    /^[a-z]:/iu.test(name) ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`${container} contains an unsafe path (${name || "unnamed entry"}). Remove it and retry.`);
  }
}

function assertLeafEntry(container: string, name: string): void {
  if (isEmailImport(name)) {
    throw new Error(`${container} contains a nested ${extname(name) || "container"} file (${name}). Extract it first.`);
  }
  if (!isSupportedAttachmentName(name)) {
    throw new Error(
      `${container} contains an unsupported file (${name}). Remove it or attach a supported file instead.`,
    );
  }
}

function flattenedName(containerStem: string, memberName: string): string {
  const extension = attachmentFileExtension(memberName) === null ? ".txt" : "";
  return safeAttachmentName(`${containerStem} - ${memberName.split("/").join(" - ")}${extension}`);
}

function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const extension = extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  let index = 2;
  let suffix = `-${index}`;
  let candidate = `${stem.slice(0, INPUT_LIMITS.attachmentName - extension.length - suffix.length)}${suffix}${extension}`;
  while (used.has(candidate)) {
    index += 1;
    suffix = `-${index}`;
    candidate = `${stem.slice(0, INPUT_LIMITS.attachmentName - extension.length - suffix.length)}${suffix}${extension}`;
  }
  used.add(candidate);
  return candidate;
}

function safeStem(name: string): string {
  const extension = extname(name);
  return safeAttachmentName(extension ? name.slice(0, -extension.length) : name) || "attachment";
}

function safeAttachmentName(name: string): string {
  const value = name
    .replace(/[^\p{L}\p{N}._ -]+/gu, "-")
    .replace(/^\.+/u, "")
    .trim();
  const extension = extname(value);
  if (!extension || extension.length >= INPUT_LIMITS.attachmentName) return value.slice(0, INPUT_LIMITS.attachmentName);
  const stem = value.slice(0, -extension.length);
  return `${stem.slice(0, INPUT_LIMITS.attachmentName - extension.length)}${extension}`;
}

function fallbackAttachmentName(mimeType: string, index: number): string {
  const extension = extensionForMimeType(mimeType);
  if (!extension) throw new Error(`Email attachment ${index} has no supported filename. Save it separately and retry.`);
  return `attachment-${index}.${extension}`;
}

function extensionForMimeType(mimeType: string): string | null {
  const normalized = mimeType.split(";", 1)[0]?.trim().toLowerCase();
  const extensions: Record<string, string> = {
    "application/json": "json",
    "application/msword": "doc",
    "application/pdf": "pdf",
    "application/rtf": "rtf",
    "application/vnd.ms-excel": "xls",
    "application/vnd.ms-powerpoint": "ppt",
    "application/vnd.oasis.opendocument.presentation": "odp",
    "application/vnd.oasis.opendocument.spreadsheet": "ods",
    "application/vnd.oasis.opendocument.text": "odt",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "image/avif": "avif",
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "text/csv": "csv",
    "text/html": "html",
    "text/markdown": "md",
    "text/plain": "txt",
  };
  return normalized ? (extensions[normalized] ?? null) : null;
}

function attachmentBytes(content: ArrayBuffer | Uint8Array | string, encoding?: "base64" | "utf8"): Uint8Array {
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  if (encoding === "base64") return new Uint8Array(Buffer.from(content, "base64"));
  return new TextEncoder().encode(content);
}

function textAttachment(name: string, content: string, mimeType = "text/plain"): AttachmentDataInput {
  return { name: safeAttachmentName(name), mimeType, bytes: new TextEncoder().encode(content) };
}

async function assertExpandedLimits(paths: string[], data: AttachmentDataInput[]): Promise<void> {
  if (paths.length + data.length > INPUT_LIMITS.attachments) {
    throw new Error(`These files expand to more than ${INPUT_LIMITS.attachments} attachments. Import fewer files.`);
  }
  const pathSizes = await Promise.all(
    paths.map(async (path) => {
      const metadata = await stat(path);
      if (!metadata.isFile()) throw new Error(`Only regular files can be attached: ${basename(path)}`);
      if (metadata.size > ATTACHMENT_LIMITS.fileBytes) throw new Error(`${basename(path)} exceeds the 100 MB limit.`);
      return metadata.size;
    }),
  );
  for (const item of data) {
    if (item.bytes.byteLength > ATTACHMENT_LIMITS.fileBytes) throw new Error(`${item.name} exceeds the 100 MB limit.`);
  }
  const total = [...pathSizes, ...data.map((item) => item.bytes.byteLength)].reduce((sum, size) => sum + size, 0);
  if (total > ATTACHMENT_LIMITS.totalBytes) throw new Error("Attachments exceed the 250 MB total limit.");
}
