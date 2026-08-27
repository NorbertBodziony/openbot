import { describe, expect, it } from "vitest";
import {
  decodeMarketplaceCursor,
  encodeMarketplaceCursor,
  marketplaceLikePattern,
  normalizeMarketplaceLimit,
  normalizeMarketplaceQuery,
  parseMarketplaceLimit,
} from "../src/server/marketplace-pagination";

describe("marketplace list inputs", () => {
  it("accepts bounded integer limits and rejects malformed values", () => {
    expect(parseMarketplaceLimit(null)).toBe(24);
    expect(parseMarketplaceLimit("1")).toBe(1);
    expect(normalizeMarketplaceLimit(50)).toBe(50);
    for (const value of ["0", "51", "1.5", "abc", "Infinity"]) {
      expect(() => parseMarketplaceLimit(value)).toThrowError(expect.objectContaining({ code: "invalid_limit" }));
    }
  });

  it("bounds queries and treats LIKE wildcards literally", () => {
    expect(normalizeMarketplaceQuery("  release_100%  ")).toBe("release_100%");
    expect(marketplaceLikePattern("release_100%")).toBe("%release\\_100\\%%");
    expect(() => normalizeMarketplaceQuery("x".repeat(101))).toThrowError(
      expect.objectContaining({ code: "invalid_query" }),
    );
  });

  it("round-trips sort-specific cursors and supports legacy default cursors", () => {
    const cursor = { primary: 42, updatedAt: 1_700_000_000_000, id: "item-1" };
    const encoded = encodeMarketplaceCursor("installs", cursor);
    expect(decodeMarketplaceCursor(encoded, "installs")).toEqual(cursor);
    expect(() => decodeMarketplaceCursor(encoded, "updated")).toThrowError(
      expect.objectContaining({ code: "invalid_cursor" }),
    );
    expect(decodeMarketplaceCursor("1700000000000", "updated")).toEqual({ legacyUpdatedAt: 1_700_000_000_000 });
    expect(() => decodeMarketplaceCursor("1700000000000", "installs")).toThrowError(
      expect.objectContaining({ code: "invalid_cursor" }),
    );
  });
});
