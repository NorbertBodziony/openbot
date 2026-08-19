import type { AgentProviderId } from "@openbot/contracts/ipc";
import type { AppServerNotification, AppServerRequest, RequestId, ResponseDecoder, RpcError } from "./protocol";

export type AgentProvider = AgentProviderId;

export interface AgentClient {
  readonly provider: AgentProvider;
  readonly running: boolean;
  start(): void;
  stop(): Promise<void>;
  request<T>(method: string, params: unknown, decoder: ResponseDecoder<T>, timeoutMs?: number): Promise<T>;
  notify(method: string, params?: unknown): void;
  respond(id: RequestId, result: unknown): void;
  respondError(id: RequestId, error: RpcError): void;
  on(event: "notification", listener: (notification: AppServerNotification) => void): this;
  on(event: "request", listener: (request: AppServerRequest) => void): this;
  on(event: "diagnostic", listener: (message: string) => void): this;
  once(event: "exit", listener: (error: Error) => void): this;
}
