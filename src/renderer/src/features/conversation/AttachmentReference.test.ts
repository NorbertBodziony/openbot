import { describe, expect, it } from "vitest";
import { attachmentReferenceBadge, attachmentReferenceTone } from "./AttachmentReference";
import { messageFileReferences } from "./FileReference";

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
    ["start-types.d.ts", "source"],
    ["component.JSX", "script"],
    ["index.html", "markup"],
    ["styles.css", "style"],
    ["budget.xlsx", "data"],
    ["brief.PDF", "document"],
    ["diagram.png", "media"],
    ["Program.cs", "default"],
    ["payload.unknown", "default"],
    ["LICENSE", "default"],
  ])("uses the expected file tone for %s", (name, tone) => {
    expect(attachmentReferenceTone(name)).toBe(tone);
  });
});

describe("messageFileReferences", () => {
  const attachment = {
    id: "report",
    name: "raport.csv",
    size: 1_024,
    kind: "file" as const,
    mimeType: "text/csv",
    previewKind: "text" as const,
    previewUrl: null,
  };

  it("recognizes an attached file name without changing the surrounding text", () => {
    expect(messageFileReferences("Here is raport.csv.", [attachment])).toMatchObject([
      { kind: "attachment", name: "raport.csv", start: 8, end: 18 },
    ]);
  });

  it("recognizes full shared paths and keeps the path out of the label", () => {
    expect(messageFileReferences("Open ~/OpenBot/Shared/raport.csv now.")).toEqual([
      {
        kind: "shared",
        path: "~/OpenBot/Shared/raport.csv",
        name: "raport.csv",
        start: 5,
        end: 32,
      },
    ]);
  });

  it("recognizes an attached file in a full path and in a name with spaces", () => {
    const pathAttachment = { ...attachment, name: "report.v1.csv" };
    const spacedAttachment = { ...attachment, name: "quarterly report.v1.csv" };

    expect(messageFileReferences("Open /Users/me/report.v1.csv.", [pathAttachment])).toMatchObject([
      {
        kind: "attachment",
        name: "report.v1.csv",
        start: 5,
        end: 28,
      },
    ]);
    expect(messageFileReferences("Please check quarterly report.v1.csv.", [spacedAttachment])).toMatchObject([
      { kind: "attachment", name: "quarterly report.v1.csv", start: 13, end: 36 },
    ]);
  });

  it("recognizes a quoted shared path with spaces", () => {
    expect(messageFileReferences('Open "~/OpenBot/Shared/quarterly report.v1.csv".')).toMatchObject([
      {
        kind: "shared",
        path: "~/OpenBot/Shared/quarterly report.v1.csv",
        name: "quarterly report.v1.csv",
      },
    ]);
  });

  it("recognizes Windows shared paths", () => {
    expect(messageFileReferences(String.raw`Open C:\Users\me\OpenBot\Shared\budget.xlsx.`)).toMatchObject([
      {
        kind: "shared",
        name: "budget.xlsx",
        path: String.raw`C:\Users\me\OpenBot\Shared\budget.xlsx`,
      },
    ]);
  });

  it("does not turn unrelated names or URLs into file references", () => {
    expect(
      messageFileReferences(
        "See https://example.com/raport.csv and https://example.com/OpenBot/Shared/other.csv and raport.csv.bak.",
        [attachment],
      ),
    ).toEqual([]);
  });
});
