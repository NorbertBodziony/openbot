import { type DynamicRecord, isBoolean, isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";

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
  contentItems: Array<{ type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string }>;
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

export interface AccountLoginStartResult {
  type: "chatgpt";
  loginId: string;
  authUrl: string;
}

export interface AccountLoginCompletedResult {
  loginId: string | null;
  success: boolean;
  error: string | null;
}

export interface AccountRateLimitWindowResult {
  usedPercent?: number | null;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}

export interface AccountRateLimitResult {
  limitId?: string | null;
  primary?: AccountRateLimitWindowResult | null;
  secondary?: AccountRateLimitWindowResult | null;
}

export interface AccountRateLimitsReadResult {
  rateLimits?: AccountRateLimitResult | null;
  rateLimitsByLimitId?: Record<string, AccountRateLimitResult | undefined> | null;
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

export type ResponseDecoder<T> = (value: unknown) => T;

export interface ModelListResponse {
  data: Array<{
    model?: string;
    displayName?: string;
    defaultReasoningEffort?: string;
    supportedReasoningEfforts?: Array<{ reasoningEffort?: string }>;
    hidden?: boolean;
  }>;
}

export function decodeModelListResponse(value: unknown): ModelListResponse {
  const data = getArray(value, "data");
  return {
    data: data.filter(isRecord).map((item) => ({
      ...(isString(item.model) ? { model: item.model } : {}),
      ...(isString(item.displayName) ? { displayName: item.displayName } : {}),
      ...(isString(item.defaultReasoningEffort) ? { defaultReasoningEffort: item.defaultReasoningEffort } : {}),
      ...(isBoolean(item.hidden) ? { hidden: item.hidden } : {}),
      ...(Array.isArray(item.supportedReasoningEfforts)
        ? {
            supportedReasoningEfforts: item.supportedReasoningEfforts
              .filter(isRecord)
              .flatMap((effort) =>
                isString(effort.reasoningEffort) ? [{ reasoningEffort: effort.reasoningEffort }] : [],
              ),
          }
        : {}),
    })),
  };
}

export function decodeRecordResponse(value: unknown): DynamicRecord {
  return requiredRecord(value, "response");
}

export function decodeAccountReadResult(value: unknown): AccountReadResult {
  const record = requiredRecord(value, "account response");
  const account = record.account;
  const requiresOpenaiAuth = record.requiresOpenaiAuth;
  if (account === null) {
    return {
      account: null,
      requiresOpenaiAuth: requiresOpenaiAuth === undefined ? false : recordBoolean(record, "requiresOpenaiAuth"),
    };
  }
  const accountRecord = requiredRecord(account, "account");
  return {
    account: {
      type: requiredString(accountRecord, "type"),
      email: optionalString(accountRecord, "email"),
      planType: optionalString(accountRecord, "planType"),
    },
    requiresOpenaiAuth: requiresOpenaiAuth === undefined ? false : recordBoolean(record, "requiresOpenaiAuth"),
  };
}

export function decodeAccountLoginStartResult(value: unknown): AccountLoginStartResult {
  const record = requiredRecord(value, "account login response");
  if (requiredString(record, "type") !== "chatgpt") throw new Error("Unexpected Codex login type.");
  const authUrl = requiredString(record, "authUrl");
  const url = new URL(authUrl);
  if (url.protocol !== "https:") throw new Error("Codex returned an unsafe login URL.");
  return { type: "chatgpt", loginId: requiredString(record, "loginId"), authUrl: url.toString() };
}

export function decodeAccountLoginCompletedResult(value: unknown): AccountLoginCompletedResult {
  const record = requiredRecord(value, "account login completion");
  const loginId = optionalString(record, "loginId");
  const error = optionalString(record, "error");
  return {
    loginId: loginId ?? null,
    success: recordBoolean(record, "success"),
    error: error ?? null,
  };
}

export function decodeAccountRateLimitsReadResult(value: unknown): AccountRateLimitsReadResult {
  const record = requiredRecord(value, "rate limits response");
  return {
    rateLimits: decodeRateLimit(record.rateLimits),
    rateLimitsByLimitId: decodeRateLimitsById(record.rateLimitsByLimitId),
  };
}

export function decodeThreadResponse(value: unknown): ThreadResponse {
  const record = requiredRecord(value, "thread response");
  return { thread: decodeThreadRecord(record.thread) };
}

export function decodeTurnResponse(value: unknown): TurnResponse {
  const record = requiredRecord(value, "turn response");
  const turn = requiredRecord(record.turn, "turn");
  const status = optionalString(turn, "status");
  return {
    turn: {
      id: requiredString(turn, "id"),
      ...(status !== undefined && status !== null ? { status } : {}),
    },
  };
}

function decodeThreadRecord(value: unknown): ThreadRecord {
  const record = requiredRecord(value, "thread");
  const turns = Array.isArray(record.turns) ? record.turns.map(decodeTurnRecord) : undefined;
  return { id: requiredString(record, "id"), ...(turns ? { turns } : {}) };
}

function decodeTurnRecord(value: unknown): TurnRecord {
  const record = requiredRecord(value, "thread turn");
  const items = Array.isArray(record.items) ? record.items.map(decodeThreadItem) : undefined;
  const status = optionalString(record, "status");
  return {
    id: requiredString(record, "id"),
    ...(status !== undefined && status !== null ? { status } : {}),
    ...(items ? { items } : {}),
  };
}

function decodeThreadItem(value: unknown): ThreadItem {
  const record = requiredRecord(value, "thread item");
  const item: ThreadItem = { type: requiredString(record, "type") };
  const id = optionalString(record, "id");
  const clientId = optionalString(record, "clientId");
  const text = optionalString(record, "text");
  const status = optionalString(record, "status");
  if (id !== undefined && id !== null) item.id = id;
  if (clientId !== undefined) item.clientId = clientId;
  if (text !== undefined && text !== null) item.text = text;
  if (status !== undefined && status !== null) item.status = status;
  const phase = optionalString(record, "phase");
  if (phase !== undefined && phase !== null) item.phase = phase;
  if (record.content !== undefined) item.content = decodeThreadContent(record.content);
  return item;
}

function decodeThreadContent(value: unknown): Array<{ type: string; text?: string }> {
  if (!Array.isArray(value)) throw new Error("Invalid thread item content.");
  return value.map((item) => {
    const record = requiredRecord(item, "thread item content");
    const text = optionalString(record, "text");
    return {
      type: requiredString(record, "type"),
      ...(text !== undefined && text !== null ? { text } : {}),
    };
  });
}

function decodeRateLimit(value: unknown): AccountRateLimitResult | null | undefined {
  if (value === undefined || value === null) return value;
  const record = requiredRecord(value, "rate limit");
  return {
    limitId: optionalString(record, "limitId"),
    primary: decodeRateLimitWindow(record.primary),
    secondary: decodeRateLimitWindow(record.secondary),
  };
}

function decodeRateLimitWindow(value: unknown): AccountRateLimitWindowResult | null | undefined {
  if (value === undefined || value === null) return value;
  const record = requiredRecord(value, "rate limit window");
  return {
    usedPercent: optionalNumber(record, "usedPercent"),
    windowDurationMins: optionalNumber(record, "windowDurationMins"),
    resetsAt: optionalNumber(record, "resetsAt"),
  };
}

function decodeRateLimitsById(value: unknown): AccountRateLimitsReadResult["rateLimitsByLimitId"] {
  if (value === undefined || value === null) return value;
  const record = requiredRecord(value, "rate limits by ID");
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => {
      const rateLimit = decodeRateLimit(item);
      return [key, rateLimit === null ? undefined : rateLimit];
    }),
  );
}

function requiredRecord(value: unknown, label: string): DynamicRecord {
  if (!isDynamicRecord(value)) throw new Error(`Invalid ${label}.`);
  return value;
}

function requiredString(record: DynamicRecord, key: string): string {
  const value = record[key];
  if (!isString(value)) throw new Error(`Invalid ${key}.`);
  return value;
}

function optionalString(record: DynamicRecord, key: string): string | null | undefined {
  const value = record[key];
  if (value === undefined || value === null || isString(value)) return value;
  throw new Error(`Invalid ${key}.`);
}

function optionalNumber(record: DynamicRecord, key: string): number | null | undefined {
  const value = record[key];
  if (value === undefined || value === null || isNumber(value)) return value;
  throw new Error(`Invalid ${key}.`);
}

function recordBoolean(record: DynamicRecord, key: string): boolean {
  const value = record[key];
  if (!isBoolean(value)) throw new Error(`Invalid ${key}.`);
  return value;
}

export function isRecord(value: unknown): value is DynamicRecord {
  return isDynamicRecord(value);
}

export function isRpcMessage(value: unknown): value is RpcMessage {
  if (!isRecord(value)) return false;

  if ("method" in value) {
    return isString(value.method);
  }

  return (isString(value.id) || isNumber(value.id)) && ("result" in value || "error" in value);
}

export function getString(record: unknown, key: string): string | null {
  return isRecord(record) && isString(record[key]) ? record[key] : null;
}

export function getRecord(record: unknown, key: string): DynamicRecord | null {
  return isRecord(record) && isRecord(record[key]) ? record[key] : null;
}

export function getArray(record: unknown, key: string): unknown[] {
  return isRecord(record) && Array.isArray(record[key]) ? record[key] : [];
}
