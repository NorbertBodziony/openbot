import { describe, expect, it } from "vitest";
import { attachmentReferenceBadge, attachmentReferenceTone } from "./AttachmentReference";

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

describe("attachmentReferenceTone", () => {
  it.each([
    ["start-types.d.ts", "blue"],
    ["component.JSX", "yellow"],
    ["index.html", "orange"],
    ["styles.css", "teal"],
    ["budget.xlsx", "green"],
    ["brief.PDF", "red"],
    ["diagram.png", "pink"],
    ["Program.cs", "purple"],
    ["payload.unknown", "purple"],
    ["LICENSE", "purple"],
  ])("uses the expected file tone for %s", (name, tone) => {
    expect(attachmentReferenceTone(name)).toBe(tone);
  });
});
