// @vitest-environment node

import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeAttachmentImports } from "./attachment-import";

const temporaryDirectories: string[] = [];
const ENCODER = new TextEncoder();

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("EML attachment imports", () => {
  it("turns an EML into readable headers, bodies, and supported attachments", async () => {
    const raw = ENCODER.encode(
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

  it("preserves ordinary paths while expanding an EML path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-attachment-import-"));
    temporaryDirectories.push(directory);
    const textPath = join(directory, "notes.txt");
    const emailPath = join(directory, "message.eml");
    await writeFile(textPath, "notes");
    await writeFile(emailPath, ["Subject: Hello", "Content-Type: text/plain", "", "Email body"].join("\r\n"));

    const result = await normalizeAttachmentImports({ paths: [textPath, emailPath], data: [] });

    expect(result.paths).toEqual([textPath]);
    expect(result.data).toMatchObject([{ name: "message - email.txt", mimeType: "text/plain" }]);
    expect(new TextDecoder().decode(result.data[0]?.bytes)).toContain("Email body");
  });

  it("rejects aggregate EML source bytes before parsing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-attachment-import-"));
    temporaryDirectories.push(directory);
    const paths = await Promise.all(
      Array.from({ length: 3 }, async (_, index) => {
        const path = join(directory, `message-${index}.eml`);
        await writeFile(path, "");
        await truncate(path, 90 * 1024 * 1024);
        return path;
      }),
    );

    await expect(normalizeAttachmentImports({ paths, data: [] })).rejects.toThrow("250 MB total limit");
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

    await expect(importEmail(ENCODER.encode(nested))).rejects.toThrow("nested .eml");
  });

  it("names supported filename-less Office attachments", async () => {
    const email = ENCODER.encode(
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
        `Content-Type: text/plain; name*0*=UTF-8''file-${index}.; name*1=txt`,
        "",
        String(index),
      ].join("\r\n"),
    );
    const email = ENCODER.encode(
      ["Subject: Crowded", 'Content-Type: multipart/mixed; boundary="openbot"', "", ...parts, "--openbot--"].join(
        "\r\n",
      ),
    );

    await expect(importEmail(email)).rejects.toThrow("more than 10 attachments");
  });

  it("rejects continued MIME boundaries before parsing", async () => {
    const email = ENCODER.encode(
      [
        "Subject: Continued boundary",
        "Content-Type: multipart/mixed; boundary*0=open; boundary*1=bot",
        "",
        "--openbot",
        "Content-Type: text/plain",
        "",
        "Message",
        "--openbot--",
      ].join("\r\n"),
    );

    await expect(importEmail(email)).rejects.toThrow("extended or continued MIME boundary");
  });

  it("rejects inline RFC822 bodies before parsing", async () => {
    const email = ENCODER.encode(
      [
        "Subject: Forwarded message",
        "Content-Type: message/rfc822",
        "Content-Disposition: inline",
        "Content-Transfer-Encoding: base64",
        "",
        "U3ViamVjdDogTmVzdGVkDQoNCkJvZHk=",
      ].join("\r\n"),
    );

    await expect(importEmail(email)).rejects.toThrow("nested .eml");
  });

  it("rejects multipart digests before parsing implicit nested messages", async () => {
    const email = ENCODER.encode(
      [
        "Subject: Digest",
        "Content-Type: multipart/digest; boundary=digest",
        "",
        "--digest",
        "Content-Disposition: inline",
        "",
        "Subject: Nested message",
        "Content-Type: text/plain",
        "",
        "Nested body",
        "--digest--",
      ].join("\r\n"),
    );

    await expect(importEmail(email)).rejects.toThrow("multipart/digest");
  });

  it("rejects duplicate MIME boundaries before parsing", async () => {
    const email = ENCODER.encode(
      [
        "Subject: Duplicate boundary",
        "Content-Type: multipart/mixed; boundary=decoy; boundary=real",
        "",
        "--real",
        "Content-Type: text/plain",
        "",
        "Message",
        "--real--",
      ].join("\r\n"),
    );

    await expect(importEmail(email)).rejects.toThrow("duplicate MIME boundary");
  });

  it("rejects a nested multipart that reuses an active boundary", async () => {
    const email = ENCODER.encode(
      [
        "Subject: Reused boundary",
        "Content-Type: multipart/mixed; boundary=same",
        "",
        "--same",
        "Content-Type: multipart/alternative; boundary=same",
        "",
        "--same",
        "Content-Type: text/plain",
        "",
        "Message",
        "--same--",
        "--same--",
      ].join("\r\n"),
    );

    await expect(importEmail(email)).rejects.toThrow("reuses an active MIME boundary");
  });

  it("does not accept nonstandard trailing boundary whitespace", async () => {
    const parts = Array.from({ length: 65 }, (_, index) =>
      ["--openbot", "Content-Type: text/plain", "", String(index)].join("\r\n"),
    );
    const email = ENCODER.encode(
      [
        "Subject: Invalid boundary suffix",
        "Content-Type: multipart/mixed; boundary=openbot",
        "",
        "--openbot--\u00a0",
        ...parts,
        "--openbot--",
      ].join("\r\n"),
    );

    await expect(importEmail(email)).rejects.toThrow("too many MIME parts");
  });

  it.each([
    ["filename*=UTF-8''r%C3%A9sum%C3%A9.pdf", "résumé.pdf"],
    ["filename*0*=UTF-8''quarterly%20; filename*1=report.pdf", "quarterly report.pdf"],
  ])("imports RFC 2231 attachment filenames (%s)", async (filename, expectedName) => {
    const email = ENCODER.encode(
      [
        "Subject: Continued filename",
        "Content-Type: multipart/mixed; boundary=openbot",
        "",
        "--openbot",
        "Content-Type: application/pdf",
        `Content-Disposition: attachment; ${filename}`,
        "Content-Transfer-Encoding: base64",
        "",
        "JVBERg==",
        "--openbot--",
      ].join("\r\n"),
    );

    await expect(importEmail(email)).resolves.toMatchObject({
      data: [{ name: "message - email.txt" }, { name: `message - ${expectedName}` }],
    });
  });

  it.each(["\u000b", "\u00a0"])("rejects nonstandard folded header whitespace %#", async (whitespace) => {
    const email = ENCODER.encode(
      [
        "Subject: Folded boundary",
        "Content-Type: multipart/mixed;",
        `${whitespace}boundary=real`,
        "",
        "--real",
        "Content-Type: text/plain",
        "",
        "Message",
        "--real--",
      ].join("\r\n"),
    );

    await expect(importEmail(email)).rejects.toThrow("unsupported folded header whitespace");
  });

  it("rejects an oversized aggregate EML header block", async () => {
    const headers = `X-Header: ${"a".repeat(1024)}\r\n`.repeat(2_100);

    await expect(importEmail(ENCODER.encode(`${headers}\r\nbody`))).rejects.toThrow("headers exceed the 2 MB limit");
  });

  it("reserves one output for a multipart HTML body", async () => {
    const parts = Array.from({ length: 10 }, (_, index) =>
      ["--openbot", "Content-Type: text/html", "", `<p>Section ${index}</p>`].join("\r\n"),
    );
    const email = ENCODER.encode(
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
    const result = await importEmail(
      ENCODER.encode(["Subject: Dashed", "Content-Type: text/plain", "", body].join("\r\n")),
    );

    expect(new TextDecoder().decode(result.data[0]?.bytes)).toContain("--- separator 69");
  });

  it("rejects unsupported top-level files with the supported next action", async () => {
    await expect(
      normalizeAttachmentImports({
        paths: [],
        data: [{ name: "installer.exe", mimeType: "application/octet-stream", bytes: new Uint8Array([1]) }],
      }),
    ).rejects.toThrow("Attach images, PDF, Office documents, email, text");
  });
});

function importEmail(bytes: Uint8Array) {
  return normalizeAttachmentImports({
    paths: [],
    data: [{ name: "message.eml", mimeType: "message/rfc822", bytes }],
  });
}

function emlWithAttachment(filename: string, mimeType: string): Uint8Array {
  return ENCODER.encode(
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
