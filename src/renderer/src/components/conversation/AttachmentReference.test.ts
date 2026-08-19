import { describe, expect, it } from "vitest";
import { attachmentReferenceBadge } from "./AttachmentReference";

describe("attachmentReferenceBadge", () => {
  it.each([
    ["start-types.d.ts", "TS"],
    ["brief.PDF", "PDF"],
    ["diagram.png", "PNG"],
    ["archive.zip", "ZIP"],
    ["proposal.docx", "DOCX"],
    ["budget.xlsx", "XLSX"],
    ["slides.pptx", "PPTX"],
    ["recording.mp4", "MP4"],
  ])("renders a compact badge for %s", (name, badge) => {
    expect(attachmentReferenceBadge(name)).toBe(badge);
  });

  it.each(["LICENSE", "payload.unknown", ".env"])("uses the document fallback for %s", (name) => {
    expect(attachmentReferenceBadge(name)).toBeNull();
  });
});
