import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { crc32, inflateRaw } from "node:zlib";
import {
  attachmentFileExtension,
  attachmentMimeTypeForName,
  isSupportedAttachmentImportName,
  isSupportedAttachmentName,
  SUPPORTED_ATTACHMENT_IMPORT_DESCRIPTION,
} from "@openbot/contracts/attachment-files";
import { ATTACHMENT_LIMITS, INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { AttachmentDataInput, ImportAttachmentsInput } from "@openbot/contracts/ipc";
import { strFromU8 } from "fflate";
import PostalMime from "postal-mime";

const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_ENCRYPTED_FLAG = 1;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_DIRECTORY_ATTRIBUTE = 0x10;
const ZIP_UNICODE_PATH_EXTRA = 0x7075;
const ZIP_MAX_DIRECTORY_ENTRIES = 64;
const UNIX_FILE_TYPE_MASK = 0o170000;
const UNIX_REGULAR_FILE = 0o100000;
const UNIX_DIRECTORY = 0o040000;
const EMAIL_MAX_HEADERS_BYTES = 2 * 1024 * 1024;
const EMAIL_MAX_NESTING_DEPTH = 32;
const EMAIL_MAX_RFC822_NESTING_DEPTH = 10;
const EMAIL_MAX_MIME_PARTS = 64;
const HEADER_DECODER = new TextDecoder("latin1");
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const CP437_HIGH =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";
interface AttachmentBudget {
  count: number;
  bytes: number;
}

interface ZipEntry {
  name: string;
  size: number;
  directory: boolean;
  crc32: number;
  compression: number;
  compressedSize: number;
  dataOffset: number;
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
    if (isContainer(name)) continue;
    paths.push(path);
    leafCount += 1;
    leafBytes += metadata.size;
  }
  for (const item of input.data) {
    const name = basename(item.name);
    assertSupportedImport(name);
    if (isContainer(name)) continue;
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
    if (!isContainer(name)) continue;
    const expanded = await expandContainer(name, new Uint8Array(await readFile(path)), budget);
    data.push(...expanded);
    consumeBudget(budget, expanded);
  }
  for (const item of input.data) {
    const name = basename(item.name);
    if (isContainer(name)) {
      const expanded = await expandContainer(name, item.bytes, budget);
      data.push(...expanded);
      consumeBudget(budget, expanded);
    } else {
      data.push({ name, mimeType: item.mimeType, bytes: item.bytes });
    }
  }

  await assertExpandedLimits(paths, data);
  return { paths, data };
}

function isContainer(name: string): boolean {
  const extension = attachmentFileExtension(name);
  return extension === "eml" || extension === "zip";
}

function assertSupportedImport(name: string): void {
  if (isSupportedAttachmentImportName(name)) return;
  throw new Error(`${name || "This file"} is not supported. Attach ${SUPPORTED_ATTACHMENT_IMPORT_DESCRIPTION}.`);
}

async function expandContainer(
  name: string,
  bytes: Uint8Array,
  budget: AttachmentBudget,
): Promise<AttachmentDataInput[]> {
  if (bytes.byteLength > ATTACHMENT_LIMITS.fileBytes) throw new Error(`${name} exceeds the 100 MB limit.`);
  const expanded =
    attachmentFileExtension(name) === "eml"
      ? await expandEmail(name, bytes, budget)
      : await expandZip(name, bytes, budget);
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

async function expandZip(name: string, bytes: Uint8Array, budget: AttachmentBudget): Promise<AttachmentDataInput[]> {
  const entries = inspectZip(name, bytes).filter((entry) => !entry.directory && !isPlatformMetadata(entry.name));
  if (entries.length === 0) throw new Error(`${name} does not contain any supported files.`);
  if (entries.length > budget.count) {
    throw new Error(`These files expand to more than ${INPUT_LIMITS.attachments} attachments. Import fewer files.`);
  }
  for (const entry of entries) {
    assertSafeMemberName(name, entry.name);
    assertLeafEntry(name, entry.name);
    if (entry.size > ATTACHMENT_LIMITS.fileBytes) {
      throw new Error(
        `${name} contains ${entry.name}, which exceeds the 100 MB limit. Extract a smaller file and retry.`,
      );
    }
  }
  const total = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (total > budget.bytes) {
    throw new Error("Attachments exceed the 250 MB total limit.");
  }

  const stem = safeStem(name);
  const usedNames = new Set<string>();
  const result: AttachmentDataInput[] = [];
  for (const entry of entries) {
    let content: Uint8Array;
    try {
      content = await extractZipEntry(bytes, entry);
    } catch {
      throw new Error(`${name} is malformed or uses an unsupported ZIP encoding. Recreate the archive and retry.`);
    }
    if (content.byteLength !== entry.size || crc32(content) !== entry.crc32) {
      throw new Error(`${name} contains a damaged entry (${entry.name}). Recreate the archive and retry.`);
    }
    const outputName = uniqueName(flattenedName(stem, entry.name), usedNames);
    result.push({ name: outputName, mimeType: attachmentMimeTypeForName(outputName), bytes: content });
  }
  return result;
}

function extractZipEntry(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const compressed = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  if (entry.compression === 0) return Promise.resolve(compressed.slice());
  return new Promise((resolve, reject) => {
    inflateRaw(compressed, { maxOutputLength: entry.size + 1 }, (error, result) => {
      if (error) reject(error);
      else resolve(new Uint8Array(result));
    });
  });
}

function inspectZip(archiveName: string, bytes: Uint8Array): ZipEntry[] {
  const endOffset = findZipEnd(bytes);
  if (endOffset < 0) throw new Error(`${archiveName} is not a valid ZIP archive. Recreate it and retry.`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const disk = view.getUint16(endOffset + 4, true);
  const centralDisk = view.getUint16(endOffset + 6, true);
  const diskEntries = view.getUint16(endOffset + 8, true);
  const entryCount = view.getUint16(endOffset + 10, true);
  const centralSize = view.getUint32(endOffset + 12, true);
  const centralOffset = view.getUint32(endOffset + 16, true);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount) {
    throw new Error(
      `${archiveName} is a multi-volume ZIP, which is not supported. Extract it first and attach the files.`,
    );
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error(`${archiveName} uses ZIP64, which is not supported. Extract it first and attach the files.`);
  }
  if (entryCount > ZIP_MAX_DIRECTORY_ENTRIES) {
    throw new Error(`${archiveName} contains too many entries. Import a smaller archive.`);
  }
  if (centralOffset + centralSize > endOffset) throw new Error(`${archiveName} has a damaged ZIP directory.`);

  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > endOffset || view.getUint32(offset, true) !== ZIP_CENTRAL_SIGNATURE) {
      throw new Error(`${archiveName} has a damaged ZIP directory.`);
    }
    const flags = view.getUint16(offset + 8, true);
    const compression = view.getUint16(offset + 10, true);
    const expectedCrc32 = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const externalAttributes = view.getUint32(offset + 38, true);
    const localOffset = view.getUint32(offset + 42, true);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    if (nextOffset > endOffset || localOffset + 30 > bytes.byteLength) {
      throw new Error(`${archiveName} has a damaged ZIP directory.`);
    }
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const extraBytes = bytes.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength);
    const name = decodeZipName(nameBytes, extraBytes, flags);
    if (names.has(name)) throw new Error(`${archiveName} contains a duplicate path (${name}). Remove it and retry.`);
    names.add(name);
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error(`${archiveName} uses ZIP64, which is not supported. Extract it first and attach the files.`);
    }
    if ((flags & ZIP_ENCRYPTED_FLAG) !== 0) {
      throw new Error(`${archiveName} contains a password-protected entry (${name}). Remove the password and retry.`);
    }
    if (compression !== 0 && compression !== 8) {
      throw new Error(
        `${archiveName} contains ${name} with unsupported ZIP compression. Recreate the archive and retry.`,
      );
    }
    if (compression === 0 && compressedSize !== size) {
      throw new Error(`${archiveName} has conflicting ZIP sizes for ${name}. Recreate it and retry.`);
    }
    if (view.getUint32(localOffset, true) !== ZIP_LOCAL_SIGNATURE) {
      throw new Error(`${archiveName} has a damaged ZIP entry (${name}).`);
    }
    const localFlags = view.getUint16(localOffset + 6, true);
    if ((localFlags & ZIP_ENCRYPTED_FLAG) !== 0) {
      throw new Error(`${archiveName} contains a password-protected entry (${name}). Remove the password and retry.`);
    }
    if (view.getUint16(localOffset + 8, true) !== compression) {
      throw new Error(`${archiveName} has conflicting ZIP metadata for ${name}. Recreate it and retry.`);
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > centralOffset) {
      throw new Error(`${archiveName} has a damaged ZIP entry (${name}).`);
    }
    const origin = view.getUint8(offset + 5);
    const unixType = origin === 3 ? (externalAttributes >>> 16) & UNIX_FILE_TYPE_MASK : 0;
    const directory =
      name.endsWith("/") || (externalAttributes & ZIP_DIRECTORY_ATTRIBUTE) !== 0 || unixType === UNIX_DIRECTORY;
    if (unixType !== 0 && unixType !== UNIX_REGULAR_FILE && unixType !== UNIX_DIRECTORY) {
      throw new Error(`${archiveName} contains a link or special file (${name}). Remove it and retry.`);
    }
    entries.push({
      name,
      size,
      directory,
      crc32: expectedCrc32,
      compression,
      compressedSize,
      dataOffset,
    });
    offset = nextOffset;
  }
  if (offset !== centralOffset + centralSize) throw new Error(`${archiveName} has a damaged ZIP directory.`);
  return entries;
}

function decodeZipName(nameBytes: Uint8Array, extraBytes: Uint8Array, flags: number): string {
  if ((flags & ZIP_UTF8_FLAG) !== 0) return strFromU8(nameBytes);
  let offset = 0;
  const view = new DataView(extraBytes.buffer, extraBytes.byteOffset, extraBytes.byteLength);
  while (offset + 4 <= extraBytes.byteLength) {
    const identifier = view.getUint16(offset, true);
    const size = view.getUint16(offset + 2, true);
    const nextOffset = offset + 4 + size;
    if (nextOffset > extraBytes.byteLength) break;
    if (
      identifier === ZIP_UNICODE_PATH_EXTRA &&
      size >= 5 &&
      extraBytes[offset + 4] === 1 &&
      view.getUint32(offset + 5, true) === crc32(nameBytes)
    ) {
      try {
        return UTF8_DECODER.decode(extraBytes.subarray(offset + 9, nextOffset));
      } catch {
        break;
      }
    }
    offset = nextOffset;
  }

  let result = "";
  for (const byte of nameBytes) result += byte < 0x80 ? String.fromCharCode(byte) : CP437_HIGH[byte - 0x80];
  return result;
}

function findZipEnd(bytes: Uint8Array): number {
  const minimum = Math.max(0, bytes.byteLength - 65_557);
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset -= 1) {
    if (
      bytes[offset] === 0x50 &&
      bytes[offset + 1] === 0x4b &&
      bytes[offset + 2] === 0x05 &&
      bytes[offset + 3] === 0x06
    ) {
      const commentLength = bytes[offset + 20] + ((bytes[offset + 21] ?? 0) << 8);
      if (offset + 22 + commentLength !== bytes.byteLength) continue;
      return offset;
    }
  }
  return -1;
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
  const root = readEmailHeaders(bytes, 0);
  ({ parts, attachments } = countEmailPart(root, parts, attachments));
  assertEmailCounts(name, budget, parts, attachments);
  const boundaries = new Set<string>();
  addEmailBoundary(root, boundaries);
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
    ({ parts, attachments } = countEmailPart(headers, parts, attachments));
    assertEmailCounts(name, budget, parts, attachments);
    addEmailBoundary(headers, boundaries);
    offset = headers.bodyOffset;

    if (emailContentType(headers) === "message/rfc822" && emailDisposition(headers) === "inline") {
      const nested = readEmailHeaders(bytes, offset);
      ({ parts, attachments } = countEmailPart(nested, parts, attachments));
      assertEmailCounts(name, budget, parts, attachments);
      addEmailBoundary(nested, boundaries);
      offset = nested.bodyOffset;
    }
  }
}

function addEmailBoundary(headers: EmailHeaders, boundaries: Set<string>): void {
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
  const value = HEADER_DECODER.decode(bytes.subarray(line.startOffset, line.endOffset)).trimEnd();
  for (const boundary of boundaries) {
    if (value === `--${boundary}`) return { value: boundary, closing: false };
    if (value === `--${boundary}--`) return { value: boundary, closing: true };
  }
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
): { parts: number; attachments: number } {
  if (!headers.recognized) return { parts: parts + 1, attachments };
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
    attachments: attachments + Number(isHtml) + Number(isAttachment),
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
  if (isContainer(name)) {
    throw new Error(`${container} contains a nested ${extname(name) || "container"} file (${name}). Extract it first.`);
  }
  if (!isSupportedAttachmentName(name)) {
    throw new Error(
      `${container} contains an unsupported file (${name}). Remove it or attach a supported file instead.`,
    );
  }
}

function isPlatformMetadata(name: string): boolean {
  const parts = name.split("/");
  const leaf = parts.at(-1) ?? "";
  return parts[0] === "__MACOSX" || leaf === ".DS_Store" || leaf.startsWith("._");
}

function flattenedName(containerStem: string, memberName: string): string {
  return safeAttachmentName(`${containerStem} - ${memberName.split("/").join(" - ")}`);
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
    "application/pdf": "pdf",
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
