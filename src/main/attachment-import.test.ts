// @vitest-environment node

import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { ATTACHMENT_LIMITS } from "@openbot/contracts/input-limits";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeAttachmentImports } from "./attachment-import";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("attachment container imports", () => {
  it("turns an EML into readable headers, bodies, and supported attachments", async () => {
    const raw = strToU8(
      [
        "From: Sender <sender@example.com>",
        "To: Recipient <recipient@example.com>",
        "Subject: Quarterly report",
        'Content-Type: multipart/mixed; boundary="openbot"',
        "",
        "--openbot",
        'Content-Type: multipart/alternative; boundary="body"',
        "",
        "--body",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Plain message",
        "--body",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<p>HTML message</p>",
        "--body--",
        "--openbot",
        'Content-Type: application/pdf; name="report.pdf"',
        'Content-Disposition: attachment; filename="report.pdf"',
        "Content-Transfer-Encoding: base64",
        "",
        "JVBERg==",
        "--openbot--",
      ].join("\r\n"),
    );

    const result = await normalizeAttachmentImports({
      paths: [],
      data: [{ name: "message.eml", mimeType: "message/rfc822", bytes: raw }],
    });

    expect(result.paths).toEqual([]);
    expect(result.data.map((item) => item.name)).toEqual([
      "message - email.txt",
      "message - email.html",
      "message - report.pdf",
    ]);
    expect(new TextDecoder().decode(result.data[0]?.bytes)).toContain("Subject: Quarterly report");
    expect(new TextDecoder().decode(result.data[0]?.bytes)).toContain("Plain message");
    expect(new TextDecoder().decode(result.data[1]?.bytes)).toContain("<p>HTML message</p>");
    expect(new TextDecoder().decode(result.data[2]?.bytes)).toBe("%PDF");
  });

  it("preserves ordinary paths while expanding a ZIP path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-attachment-import-"));
    temporaryDirectories.push(directory);
    const textPath = join(directory, "notes.txt");
    const zipPath = join(directory, "bundle.zip");
    await writeFile(textPath, "notes");
    await writeFile(zipPath, zipSync({ "folder/report.txt": strToU8("report") }));

    const result = await normalizeAttachmentImports({ paths: [textPath, zipPath], data: [] });

    expect(result.paths).toEqual([textPath]);
    expect(result.data).toMatchObject([
      { name: "bundle - folder - report.txt", mimeType: "text/plain", bytes: strToU8("report") },
    ]);
  });

  it("ignores directories and conventional platform metadata in ZIP files", async () => {
    const bytes = zipSync({
      "folder/": new Uint8Array(),
      "__MACOSX/._report.txt": strToU8("metadata"),
      "folder/.DS_Store": strToU8("metadata"),
      "folder/report.txt": strToU8("report"),
    });

    const result = await normalizeAttachmentImports({
      paths: [],
      data: [{ name: "bundle.zip", mimeType: "application/zip", bytes }],
    });

    expect(result.data.map((item) => item.name)).toEqual(["bundle - folder - report.txt"]);
  });

  it("decodes CP437 and Info-ZIP Unicode attachment paths", async () => {
    const cp437 = patchFirstZipEntry(zipSync({ "cafx.txt": strToU8("legacy") }), (view, central, local) => {
      view.setUint16(central + 8, view.getUint16(central + 8, true) & ~0x0800, true);
      view.setUint16(local + 6, view.getUint16(local + 6, true) & ~0x0800, true);
      view.setUint8(central + 46 + 3, 0x82);
      view.setUint8(local + 30 + 3, 0x82);
    });
    const unicode = zipSync({
      "cafe.txt": [strToU8("unicode"), { extra: { 28789: unicodePathExtra(strToU8("cafe.txt"), "café.txt") } }],
    });

    await expect(importZip(cp437)).resolves.toMatchObject({ data: [{ name: "bundle - café.txt" }] });
    await expect(importZip(unicode)).resolves.toMatchObject({ data: [{ name: "bundle - café.txt" }] });
  });

  it("keeps supported extensionless ZIP members attachable after flattening", async () => {
    await expect(importZip(zipSync({ Dockerfile: strToU8("FROM scratch") }))).resolves.toMatchObject({
      data: [{ name: "bundle - Dockerfile.txt", mimeType: "text/plain" }],
    });
  });

  it.each([
    ["unsafe path", zipSync({ "../secret.txt": strToU8("secret") }), "unsafe path"],
    ["nested archive", zipSync({ "nested.zip": strToU8("zip") }), "nested .zip"],
    ["unsupported file", zipSync({ "program.exe": strToU8("binary") }), "unsupported file"],
    ["link", zipSync({ "link.txt": [strToU8("target"), { os: 3, attrs: 0o120777 << 16 }] }), "link or special"],
  ])("rejects a ZIP containing an %s", async (_case, bytes, message) => {
    await expect(
      normalizeAttachmentImports({
        paths: [],
        data: [{ name: "bundle.zip", mimeType: "application/zip", bytes }],
      }),
    ).rejects.toThrow(message);
  });

  it("rejects encrypted and unsupported ZIP encodings before extraction", async () => {
    const encrypted = patchFirstZipEntry(zipSync({ "report.txt": strToU8("report") }), (view, central, local) => {
      view.setUint16(central + 8, view.getUint16(central + 8, true) | 1, true);
      view.setUint16(local + 6, view.getUint16(local + 6, true) | 1, true);
    });
    const unsupported = patchFirstZipEntry(zipSync({ "report.txt": strToU8("report") }), (view, central, local) => {
      view.setUint16(central + 10, 99, true);
      view.setUint16(local + 8, 99, true);
    });

    await expect(importZip(encrypted)).rejects.toThrow("password-protected");
    await expect(importZip(unsupported)).rejects.toThrow("unsupported ZIP compression");
  });

  it("rejects ZIP entries that fail their integrity check", async () => {
    const damaged = patchFirstZipEntry(zipSync({ "report.txt": strToU8("report") }), (view, central) => {
      view.setUint32(central + 16, 0, true);
    });

    await expect(importZip(damaged)).rejects.toThrow("damaged entry");
  });

  it("rejects ZIP entries whose output exceeds their declared size", async () => {
    const expanded = patchFirstZipEntry(
      zipSync({ "report.txt": strToU8("content".repeat(200_000)) }),
      (view, central, local) => {
        view.setUint32(central + 16, 0, true);
        view.setUint32(central + 24, 0, true);
        view.setUint32(local + 14, 0, true);
        view.setUint32(local + 22, 0, true);
      },
    );

    await expect(importZip(expanded)).rejects.toThrow("malformed or uses an unsupported ZIP encoding");
  });

  it("rejects malformed, oversized, and over-populated ZIP files", async () => {
    const oversized = patchFirstZipEntry(zipSync({ "report.txt": strToU8("report") }), (view, central, local) => {
      const size = ATTACHMENT_LIMITS.fileBytes + 1;
      view.setUint32(central + 24, size, true);
      view.setUint32(local + 22, size, true);
    });
    const crowded = zipSync(
      Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`file-${index}.txt`, strToU8(String(index))])),
    );
    const excessiveEntries = zipSync(
      Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`folder-${index}/`, new Uint8Array()])),
    );
    const excessiveTotal = patchEveryZipEntry(
      zipSync({ "one.txt": strToU8("1"), "two.txt": strToU8("2"), "three.txt": strToU8("3") }),
      (view, central, local) => {
        const size = 90 * 1024 * 1024;
        view.setUint32(central + 24, size, true);
        view.setUint32(local + 22, size, true);
      },
    );

    await expect(importZip(new Uint8Array([1, 2, 3]))).rejects.toThrow("not a valid ZIP");
    await expect(importZip(oversized)).rejects.toThrow("exceeds the 100 MB limit");
    await expect(importZip(crowded)).rejects.toThrow("more than 10 attachments");
    await expect(importZip(excessiveEntries)).rejects.toThrow("too many entries");
    await expect(importZip(excessiveTotal)).rejects.toThrow("250 MB total limit");
  });

  it("applies the remaining aggregate budgets before extracting a ZIP", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-attachment-import-"));
    temporaryDirectories.push(directory);
    const largePaths = await Promise.all(
      Array.from({ length: 2 }, async (_, index) => {
        const path = join(directory, `large-${index}.txt`);
        await writeFile(path, "");
        await truncate(path, ATTACHMENT_LIMITS.fileBytes);
        return path;
      }),
    );
    const excessiveBytes = patchFirstZipEntry(zipSync({ "report.txt": strToU8("report") }), (view, central, local) => {
      const size = 60 * 1024 * 1024;
      view.setUint32(central + 24, size, true);
      view.setUint32(local + 22, size, true);
    });
    const excessiveCount = patchFirstZipEntry(
      zipSync({ "one.txt": strToU8("1"), "two.txt": strToU8("2") }),
      (view, central) => view.setUint32(central + 16, 0, true),
    );
    const leafData = Array.from({ length: 9 }, (_, index) => ({
      name: `leaf-${index}.txt`,
      mimeType: "text/plain",
      bytes: strToU8(String(index)),
    }));

    await expect(
      normalizeAttachmentImports({
        paths: largePaths,
        data: [{ name: "bundle.zip", mimeType: "application/zip", bytes: excessiveBytes }],
      }),
    ).rejects.toThrow("250 MB total limit");
    await expect(
      normalizeAttachmentImports({
        paths: [],
        data: [...leafData, { name: "bundle.zip", mimeType: "application/zip", bytes: excessiveCount }],
      }),
    ).rejects.toThrow("more than 10 attachments");
  });

  it("rejects malformed email and unsafe email attachments transactionally", async () => {
    const unsupported = emlWithAttachment("program.exe", "application/octet-stream");
    const nested = emlWithAttachment("forwarded.eml", "message/rfc822");

    await expect(importEmail(new Uint8Array())).rejects.toThrow("recognizable email");
    await expect(importEmail(unsupported)).rejects.toThrow("unsupported file");
    await expect(importEmail(nested)).rejects.toThrow("nested .eml");
  });

  it("bounds explicitly inline nested EML messages", async () => {
    let nested = ["Subject: Leaf", "Content-Type: text/plain", "", "Leaf"].join("\r\n");
    for (let depth = 0; depth < 12; depth += 1) {
      nested = [
        `Subject: Nested ${depth}`,
        "Content-Type: message/rfc822",
        'Content-Disposition: inline; filename="nested.eml"',
        "",
        nested,
      ].join("\r\n");
    }

    await expect(importEmail(strToU8(nested))).rejects.toThrow("nested .eml");
  });

  it("names supported filename-less Office attachments", async () => {
    const email = strToU8(
      [
        "Subject: Document",
        'Content-Type: multipart/mixed; boundary="openbot"',
        "",
        "--openbot",
        "Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition: attachment",
        "Content-Transfer-Encoding: base64",
        "",
        "ZG9jeA==",
        "--openbot--",
      ].join("\r\n"),
    );

    await expect(importEmail(email)).resolves.toMatchObject({
      data: [{ name: "message - email.txt" }, { name: "message - attachment-1.docx" }],
    });
  });

  it("rejects an over-populated EML before parsing its attachments", async () => {
    const parts = Array.from({ length: 10 }, (_, index) =>
      [
        "--openbot",
        "Malformed header without a colon",
        `Content-Type: text/plain; name="file-${index}.txt"`,
        "",
        String(index),
      ].join("\r\n"),
    );
    const email = strToU8(
      ["Subject: Crowded", 'Content-Type: multipart/mixed; boundary="openbot"', "", ...parts, "--openbot--"].join(
        "\r\n",
      ),
    );

    await expect(importEmail(email)).rejects.toThrow("more than 10 attachments");
  });

  it("rejects an oversized aggregate EML header block", async () => {
    const headers = `X-Header: ${"a".repeat(1024)}\r\n`.repeat(2_100);

    await expect(importEmail(strToU8(`${headers}\r\nbody`))).rejects.toThrow("headers exceed the 2 MB limit");
  });

  it("reserves one output for a multipart HTML body", async () => {
    const parts = Array.from({ length: 10 }, (_, index) =>
      ["--openbot", "Content-Type: text/html", "", `<p>Section ${index}</p>`].join("\r\n"),
    );
    const email = strToU8(
      ["Subject: HTML", 'Content-Type: multipart/alternative; boundary="openbot"', "", ...parts, "--openbot--"].join(
        "\r\n",
      ),
    );

    await expect(importEmail(email)).resolves.toMatchObject({
      data: [{ name: "message - email.txt" }, { name: "message - email.html" }],
    });
  });

  it("does not treat dashed plain-text body lines as MIME boundaries", async () => {
    const body = Array.from({ length: 70 }, (_, index) => `--- separator ${index}`).join("\r\n");
    const result = await importEmail(strToU8(["Subject: Dashed", "Content-Type: text/plain", "", body].join("\r\n")));

    expect(new TextDecoder().decode(result.data[0]?.bytes)).toContain("--- separator 69");
  });

  it("rejects unsupported top-level files with the supported next action", async () => {
    await expect(
      normalizeAttachmentImports({
        paths: [],
        data: [{ name: "installer.exe", mimeType: "application/octet-stream", bytes: new Uint8Array([1]) }],
      }),
    ).rejects.toThrow("Attach images, PDF, Office documents, email, ZIP archives");
  });
});

function importZip(bytes: Uint8Array) {
  return normalizeAttachmentImports({
    paths: [],
    data: [{ name: "bundle.zip", mimeType: "application/zip", bytes }],
  });
}

function importEmail(bytes: Uint8Array) {
  return normalizeAttachmentImports({
    paths: [],
    data: [{ name: "message.eml", mimeType: "message/rfc822", bytes }],
  });
}

function emlWithAttachment(filename: string, mimeType: string): Uint8Array {
  return strToU8(
    [
      "Subject: Attachment",
      'Content-Type: multipart/mixed; boundary="openbot"',
      "",
      "--openbot",
      "Content-Type: text/plain",
      "",
      "Message",
      "--openbot",
      `Content-Type: ${mimeType}; name="${filename}"`,
      `Content-Disposition: attachment; filename="${filename}"`,
      "Content-Transfer-Encoding: base64",
      "",
      "Ynl0ZXM=",
      "--openbot--",
    ].join("\r\n"),
  );
}

function unicodePathExtra(legacyName: Uint8Array, unicodeName: string): Uint8Array {
  const encoded = strToU8(unicodeName);
  const result = new Uint8Array(5 + encoded.byteLength);
  const view = new DataView(result.buffer);
  result[0] = 1;
  view.setUint32(1, crc32(legacyName), true);
  result.set(encoded, 5);
  return result;
}

function patchFirstZipEntry(
  source: Uint8Array,
  patch: (view: DataView, centralOffset: number, localOffset: number) => void,
): Uint8Array {
  const bytes = source.slice();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let centralOffset = -1;
  for (let offset = 0; offset <= bytes.byteLength - 4; offset += 1) {
    if (view.getUint32(offset, true) === 0x02014b50) {
      centralOffset = offset;
      break;
    }
  }
  if (centralOffset < 0) throw new Error("Test ZIP has no central directory entry.");
  patch(view, centralOffset, view.getUint32(centralOffset + 42, true));
  return bytes;
}

function patchEveryZipEntry(
  source: Uint8Array,
  patch: (view: DataView, centralOffset: number, localOffset: number) => void,
): Uint8Array {
  const bytes = source.slice();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset <= bytes.byteLength - 46; offset += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue;
    patch(view, offset, view.getUint32(offset + 42, true));
  }
  return bytes;
}
