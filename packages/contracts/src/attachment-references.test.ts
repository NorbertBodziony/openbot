import { describe, expect, it } from "vitest";
import {
  attachmentReferenceIds,
  attachmentReferences,
  expandAttachmentReferences,
  removeAttachmentReferences,
  rewriteAttachmentReferences,
  serializeAttachmentReference,
} from "./attachment-references";

describe("attachment references", () => {
  it("serializes and parses inline file references", () => {
    const marker = serializeAttachmentReference("start-types.d.ts", "draft-1");
    expect(marker).toBe("@[start-types.d.ts](attachment:draft-1)");
    expect(attachmentReferences(`Review ${marker} now`)).toEqual([
      expect.objectContaining({
        attachmentId: "draft-1",
        name: "start-types.d.ts",
        marker,
      }),
    ]);
    expect(attachmentReferenceIds(marker)).toEqual(new Set(["draft-1"]));
  });

  it("rewrites known references and degrades unknown references to plain names", () => {
    const known = serializeAttachmentReference("draft.ts", "draft-1");
    const missing = serializeAttachmentReference("missing.md", "missing");
    const value = rewriteAttachmentReferences(`${known} and ${missing}`, (reference) =>
      reference.attachmentId === "draft-1" ? { attachmentId: "attachment-1", name: "draft.ts" } : null,
    );

    expect(value).toBe(`${serializeAttachmentReference("draft.ts", "attachment-1")} and missing.md`);
    expect(expandAttachmentReferences(value)).toBe("draft.ts and missing.md");
  });

  it("removes every reference to a discarded attachment", () => {
    const marker = serializeAttachmentReference("notes.md", "draft-1");
    expect(removeAttachmentReferences(`Use ${marker} then ${marker}`, "draft-1")).toBe("Use  then ");
  });
});
