import { INPUT_LIMITS } from "./input-limits";

const DOMAIN_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/iu;
const EMAIL_LOCAL_PART_PATTERN = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/u;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TEAM_HOST_PATTERN =
  /^(vnc-)?([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)-([a-z2-7]{8})-host\.openbot\.run$/u;
const TEAM_HOST_SLUG_MIN_LENGTH = 6;
const TEAM_HOST_SLUG_MAX_LENGTH = 44;

export function isValidHostname(value: string, requireDot = true): boolean {
  if (
    value.length === 0 ||
    value.length > INPUT_LIMITS.hostname ||
    (requireDot && !value.includes("."))
  ) {
    return false;
  }
  return value
    .split(".")
    .every((label) => label.length > 0 && label.length <= 63 && DOMAIN_LABEL_PATTERN.test(label));
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

export function isUuidV4(value: string): boolean {
  return UUID_V4_PATTERN.test(value);
}

export function isOpenBotTeamApiHostname(value: string): boolean {
  const match = TEAM_HOST_PATTERN.exec(value);
  return Boolean(match && !match[1] && isValidTeamHostSlug(match[2]));
}

export function isOpenBotTeamVncHostname(value: string): boolean {
  const match = TEAM_HOST_PATTERN.exec(value);
  return Boolean(match && match[1] === "vnc-" && isValidTeamHostSlug(match[2]));
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
