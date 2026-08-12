export type RequestId = string | number;

export interface RpcRequest {
  method: string;
  id: RequestId;
  params?: unknown;
}

export interface RpcNotification {
  method: string;
  params?: unknown;
}

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface RpcResponse {
  id: RequestId;
  result?: unknown;
  error?: RpcError;
}

export type RpcMessage = RpcRequest | RpcNotification | RpcResponse;

export interface DynamicToolCallParams {
  threadId: string;
  turnId: string;
  callId: string;
  namespace: string | null;
  tool: string;
  arguments: unknown;
}

export interface DynamicToolResult {
  contentItems: Array<
    { type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string }
  >;
  success: boolean;
}

export interface AppServerNotification {
  method: string;
  params: unknown;
}

export interface AppServerRequest {
  method: string;
  id: RequestId;
  params: unknown;
}

export interface AccountReadResult {
  account: null | {
    type: string;
    email?: string | null;
    planType?: string | null;
  };
  requiresOpenaiAuth: boolean;
}

export interface AccountRateLimitWindowResult {
  usedPercent?: number | null;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}

export interface AccountRateLimitResult {
  limitId?: string | null;
  limitName?: string | null;
  primary?: AccountRateLimitWindowResult | null;
  secondary?: AccountRateLimitWindowResult | null;
  planType?: string | null;
}

export interface AccountRateLimitsReadResult {
  rateLimits?: AccountRateLimitResult | null;
  rateLimitsByLimitId?: Record<string, AccountRateLimitResult | undefined> | null;
}

export interface AccountUsageReadResult {
  summary?: {
    lifetimeTokens?: number | null;
    peakDailyTokens?: number | null;
    currentStreakDays?: number | null;
    longestStreakDays?: number | null;
  } | null;
}

export interface ThreadItem {
  type: string;
  id?: string;
  clientId?: string | null;
  text?: string;
  content?: Array<{ type: string; text?: string }>;
  status?: string;
  [key: string]: unknown;
}

export interface TurnRecord {
  id: string;
  status?: string;
  startedAt?: number;
  items?: ThreadItem[];
}

export interface ThreadRecord {
  id: string;
  turns?: TurnRecord[];
}

export interface ThreadResponse {
  thread: ThreadRecord;
}

export interface TurnResponse {
  turn: {
    id: string;
    status?: string;
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isRpcMessage(value: unknown): value is RpcMessage {
  if (!isRecord(value)) return false;

  if ("method" in value) {
    return typeof value.method === "string";
  }

  return (
    (typeof value.id === "string" || typeof value.id === "number") &&
    ("result" in value || "error" in value)
  );
}

export function getString(record: unknown, key: string): string | null {
  return isRecord(record) && typeof record[key] === "string" ? record[key] : null;
}

export function getRecord(record: unknown, key: string): Record<string, unknown> | null {
  return isRecord(record) && isRecord(record[key]) ? record[key] : null;
}

export function getArray(record: unknown, key: string): unknown[] {
  return isRecord(record) && Array.isArray(record[key]) ? record[key] : [];
}
