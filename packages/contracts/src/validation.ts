import { INPUT_LIMITS } from "./input-limits";

const DOMAIN_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/iu;
const EMAIL_LOCAL_PART_PATTERN = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/u;
export const ONE_TIME_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const ONE_TIME_CODE_LENGTH = 8;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TEAM_HOST_PATTERN = /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)-([a-z2-7]{8})-host\.openbot\.run$/u;
const TEAM_HOST_SLUG_MIN_LENGTH = 6;
const TEAM_HOST_SLUG_MAX_LENGTH = 44;
const ACCOUNT_NAME_UNSAFE_CHARACTER_PATTERN = /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u;
const ACCOUNT_NAME_FORMAT_CHARACTER_PATTERN = /\p{Cf}/u;
const ACCOUNT_NAME_ALLOWED_FORMAT_CHARACTERS = new Set(["\u200c", "\u200d"]);

export function normalizeAccountName(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\p{Zs}+/gu, " ")
    .trim();
}

export function hasUnsafeAccountNameCharacters(value: string): boolean {
  if (ACCOUNT_NAME_UNSAFE_CHARACTER_PATTERN.test(value)) return true;
  return [...value].some(
    (character) =>
      ACCOUNT_NAME_FORMAT_CHARACTER_PATTERN.test(character) && !ACCOUNT_NAME_ALLOWED_FORMAT_CHARACTERS.has(character),
  );
}

export function isValidHostname(value: string, requireDot = true): boolean {
  if (value.length === 0 || value.length > INPUT_LIMITS.hostname || (requireDot && !value.includes("."))) {
    return false;
  }
  return value.split(".").every((label) => label.length > 0 && label.length <= 63 && DOMAIN_LABEL_PATTERN.test(label));
}

export function normalizeEmailAddress(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  const parts = normalized.split("@");
  if (
    normalized.length > INPUT_LIMITS.email ||
    parts.length !== 2 ||
    !parts[0] ||
    parts[0].length > 64 ||
    !EMAIL_LOCAL_PART_PATTERN.test(parts[0]) ||
    !parts[1] ||
    !isValidHostname(parts[1])
  ) {
    return null;
  }
  return normalized;
}

export function normalizeOneTimeCode(value: string): string | null {
  const normalized = value.toUpperCase().replace(/[\s-]/gu, "");
  return normalized.length === ONE_TIME_CODE_LENGTH &&
    [...normalized].every((character) => ONE_TIME_CODE_ALPHABET.includes(character))
    ? normalized
    : null;
}

export function isUuidV4(value: string): boolean {
  return UUID_V4_PATTERN.test(value);
}

export function isOpenBotTeamApiHostname(value: string): boolean {
  const match = TEAM_HOST_PATTERN.exec(value);
  return Boolean(match && !value.startsWith("vnc-") && isValidTeamHostSlug(match[1]));
}

export function slugifyTeamServerName(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase();
  return normalized
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, TEAM_HOST_SLUG_MAX_LENGTH)
    .replace(/-+$/gu, "");
}

function isValidTeamHostSlug(value: string | undefined): boolean {
  return Boolean(
    value &&
      value.length >= TEAM_HOST_SLUG_MIN_LENGTH &&
      value.length <= TEAM_HOST_SLUG_MAX_LENGTH &&
      !value.includes("--") &&
      DOMAIN_LABEL_PATTERN.test(value),
  );
}
