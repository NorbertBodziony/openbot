import { describe, expect, it } from "vitest";
import { ATTACHMENT_FILE_ACCEPT, attachmentMimeTypeForName, isSupportedAttachmentName } from "./attachment-files";

describe("attachment file whitelist", () => {
  it("accepts images, documents, text, Markdown, data, and source files", () => {
    expect(
      ["photo.png", "brief.pdf", "notes.txt", "README.MD", "data.json", "app.tsx", "report.docx", "Dockerfile"].every(
        isSupportedAttachmentName,
      ),
    ).toBe(true);
    expect(ATTACHMENT_FILE_ACCEPT).toContain(".pdf");
    expect(ATTACHMENT_FILE_ACCEPT).toContain(".md");
    expect(ATTACHMENT_FILE_ACCEPT).toContain(".txt");
  });

  it("rejects executable and archive formats", () => {
    expect(isSupportedAttachmentName("installer.exe")).toBe(false);
    expect(isSupportedAttachmentName("bundle.zip")).toBe(false);
    expect(isSupportedAttachmentName("no-extension")).toBe(false);
  });

  it("assigns stable MIME types to supported formats", () => {
    expect(attachmentMimeTypeForName("README.md")).toBe("text/markdown");
    expect(attachmentMimeTypeForName("report.pdf")).toBe("application/pdf");
    expect(attachmentMimeTypeForName("report.docx")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(attachmentMimeTypeForName("bundle.zip")).toBe("application/octet-stream");
  });
});
