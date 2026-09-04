const MOBILE_CONNECT_PROTOCOL = "openbot:";
const MOBILE_CONNECT_HOST = "mobile-connect";

export interface MobileConnectHostBinding {
  hostId: string;
  fingerprint: string;
}

export function isMobileConnectHostBinding(value: unknown): value is MobileConnectHostBinding {
  if (!value || typeof value !== "object" || !("hostId" in value) || !("fingerprint" in value)) return false;
  return (
    typeof value.hostId === "string" &&
    /^[A-Za-z0-9-]{1,128}$/u.test(value.hostId) &&
    typeof value.fingerprint === "string" &&
    /^[A-Za-z0-9_-]{43}$/u.test(value.fingerprint)
  );
}

export function validateMobileConnectHostBinding(
  expected: MobileConnectHostBinding,
  received: unknown,
): MobileConnectHostBinding {
  if (
    !isMobileConnectHostBinding(received) ||
    received.hostId !== expected.hostId ||
    received.fingerprint !== expected.fingerprint
  ) {
    throw new Error("The redeemed Mobile Connect code belongs to a different desktop identity.");
  }
  return received;
}

export interface MobileConnectTicket {
  qrData: string;
  expiresAt: number;
}

export type MobileDevicePlatform = "ios" | "android" | "unknown";

export interface MobileConnectedDevice {
  sessionId: string;
  name: string;
  platform: MobileDevicePlatform;
  connectedAt: number;
  lastActiveAt: number;
}

export interface AccountSession {
  sessionId: string;
  name: string;
  kind: "desktop" | "mobile";
  current: boolean;
  connectedAt: number;
  lastActiveAt: number;
}

export interface MobileConnectPayload {
  apiUrl: string;
  ticket: string;
  host?: MobileConnectHostBinding;
}

export function createMobileConnectUrl(payload: MobileConnectPayload): string {
  const apiUrl = normalizeMobileConnectApiUrl(payload.apiUrl);
  const ticket = normalizeMobileConnectTicket(payload.ticket);
  if (!apiUrl || !ticket) throw new Error("Invalid Mobile Connect payload.");
  const url = new URL(`${MOBILE_CONNECT_PROTOCOL}//${MOBILE_CONNECT_HOST}`);
  url.searchParams.set("api", apiUrl);
  url.searchParams.set("ticket", ticket);
  if (payload.host) {
    if (!isMobileConnectHostBinding(payload.host)) throw new Error("Invalid Mobile Connect host.");
    url.searchParams.set("host", payload.host.hostId);
    url.searchParams.set("fingerprint", payload.host.fingerprint);
  }
  return url.toString();
}

export function parseMobileConnectUrl(value: string): MobileConnectPayload | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== MOBILE_CONNECT_PROTOCOL ||
      url.hostname !== MOBILE_CONNECT_HOST ||
      (url.pathname !== "" && url.pathname !== "/") ||
      url.hash !== "" ||
      [...url.searchParams.keys()].some(
        (key) => !["api", "ticket", "host", "fingerprint"].includes(key) || url.searchParams.getAll(key).length !== 1,
      )
    ) {
      return null;
    }
    const apiUrl = normalizeMobileConnectApiUrl(url.searchParams.get("api") ?? "");
    const ticket = normalizeMobileConnectTicket(url.searchParams.get("ticket") ?? "");
    const hasHost = url.searchParams.has("host") || url.searchParams.has("fingerprint");
    const host = { hostId: url.searchParams.get("host"), fingerprint: url.searchParams.get("fingerprint") };
    if (hasHost && !isMobileConnectHostBinding(host)) return null;
    return apiUrl && ticket ? { apiUrl, ticket, ...(isMobileConnectHostBinding(host) ? { host } : {}) } : null;
  } catch {
    return null;
  }
}

function normalizeMobileConnectApiUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && isMobileConnectDevelopmentHost(url.hostname))) ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function isMobileConnectDevelopmentHost(hostname: string): boolean {
  if (hostname === "127.0.0.1" || hostname === "localhost") return true;
  const octets = hostname.split(".");
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/u.test(octet))) return false;
  const values = octets.map(Number);
  if (values.some((value) => value < 0 || value > 255)) return false;
  const [first, second] = values;
  return (
    first === 10 ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function normalizeMobileConnectTicket(value: string): string | null {
  const ticket = value.trim();
  return /^[A-Za-z0-9_-]{32,128}$/u.test(ticket) ? ticket : null;
}
