import { isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";

export const MARKETPLACE_DEFAULT_PAGE_SIZE = 24;
export const MARKETPLACE_MAX_PAGE_SIZE = 50;
export const MARKETPLACE_MAX_QUERY_LENGTH = 100;
const MAX_CURSOR_LENGTH = 512;

export type MarketplaceSort = "updated" | "installs";

export interface MarketplaceCursor {
  primary: number;
  updatedAt: number;
  id: string;
}

export class MarketplaceQueryError extends Error {
  constructor(
    readonly code: "invalid_cursor" | "invalid_limit" | "invalid_query",
    message: string,
  ) {
    super(message);
  }
}

export function parseMarketplaceLimit(value: string | null): number {
  if (value === null) return MARKETPLACE_DEFAULT_PAGE_SIZE;
  const parsed = Number(value);
  return normalizeMarketplaceLimit(parsed);
}

export function normalizeMarketplaceLimit(value: number | undefined): number {
  const limit = value ?? MARKETPLACE_DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MARKETPLACE_MAX_PAGE_SIZE) {
    throw new MarketplaceQueryError("invalid_limit", "The page limit must be an integer from 1 to 50.");
  }
  return limit;
}

export function normalizeMarketplaceQuery(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const query = value.trim();
  if (query.length > MARKETPLACE_MAX_QUERY_LENGTH) {
    throw new MarketplaceQueryError("invalid_query", "The marketplace query must be 100 characters or fewer.");
  }
  return query || undefined;
}

export function marketplaceLikePattern(value: string): string {
  return `%${value.toLowerCase().replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

export function encodeMarketplaceCursor(sort: MarketplaceSort, cursor: MarketplaceCursor): string {
  const value = JSON.stringify({ v: 1, s: sort, p: cursor.primary, u: cursor.updatedAt, i: cursor.id });
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function decodeMarketplaceCursor(
  value: string | undefined,
  sort: MarketplaceSort,
): MarketplaceCursor | { legacyUpdatedAt: number } | null {
  if (!value) return null;
  if (value.length > MAX_CURSOR_LENGTH) throw invalidCursor();
  if (/^\d+$/u.test(value) && sort === "updated") {
    const legacyUpdatedAt = Number(value);
    if (Number.isSafeInteger(legacyUpdatedAt)) return { legacyUpdatedAt };
  }
  try {
    const encoded = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "="));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (
      !isDynamicRecord(parsed) ||
      parsed.v !== 1 ||
      parsed.s !== sort ||
      !isNumber(parsed.p) ||
      !Number.isSafeInteger(parsed.p) ||
      !isNumber(parsed.u) ||
      !Number.isSafeInteger(parsed.u) ||
      !isString(parsed.i) ||
      parsed.i.length === 0 ||
      parsed.i.length > 128
    ) {
      throw invalidCursor();
    }
    return { primary: parsed.p, updatedAt: parsed.u, id: parsed.i };
  } catch (error) {
    if (error instanceof MarketplaceQueryError) throw error;
    throw invalidCursor();
  }
}

function invalidCursor(): MarketplaceQueryError {
  return new MarketplaceQueryError("invalid_cursor", "The marketplace cursor is invalid.");
}
