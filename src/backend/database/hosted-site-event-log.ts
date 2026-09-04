import type {
  HostedSiteConversationEvent,
  HostedSiteConversationEventAction,
  HostedSiteConversationEventDetails,
  HostedSiteConversationEventStatus,
} from "@openbot/contracts/ipc";
import { hostedSiteConversationEvent } from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import type { DatabaseCore } from "./database-core";
import { databaseRows, requiredStringColumn } from "./database-rows";

export interface PendingHostedSiteTerminalEvent {
  botId: string;
  threadId: string;
  turnId: string;
  operationId: string;
  action: HostedSiteConversationEventAction;
  status: Exclude<HostedSiteConversationEventStatus, "running">;
  details: HostedSiteConversationEventDetails;
  markerCommandId: string;
  createdAt: string;
}

export interface ActiveHostedSiteConversationEvent {
  botId: string;
  threadId: string;
  turnId: string;
  createdAt: string;
  event: HostedSiteConversationEvent & { status: "running" };
}

export interface HostedSiteEventLogOptions {
  core: DatabaseCore;
}

/**
 * The hosted-site publish operations a conversation is waiting on, and the terminal events whose
 * conversation marker has not been written yet.
 *
 * Owns both hosted-site aggregates in the orchestration event log — `hosted-site-operation` for a
 * running operation and `hosted-site-terminal` for a pending terminal event — and the validators
 * that refuse a payload the conversation marker could not be rebuilt from. Reads them back by
 * scanning the event log directly, so a pending event survives a restart with no projection table
 * behind it. The class never imports the facade.
 */
export class HostedSiteEventLog {
  readonly #core: DatabaseCore;

  constructor(options: HostedSiteEventLogOptions) {
    this.#core = options.core;
  }

  recordPendingHostedSiteTerminalEvent(event: PendingHostedSiteTerminalEvent): void {
    validatePendingHostedSiteTerminalEvent(event);
    this.#core.dispatch(
      `hosted-site-terminal-pending:${event.botId}:${event.operationId}:${event.status}`,
      [
        {
          aggregateType: "hosted-site-terminal",
          aggregateId: event.botId,
          eventType: "hosted-site.terminal-pending",
          occurredAt: event.createdAt,
          payload: event,
        },
      ],
      () => null,
    );
  }

  pendingHostedSiteTerminalEvents(): PendingHostedSiteTerminalEvent[] {
    const pending: PendingHostedSiteTerminalEvent[] = [];
    for (const row of databaseRows(
      this.#core.connection
        .prepare(
          `SELECT pending.payload_json
           FROM orchestration_events pending
           LEFT JOIN orchestration_command_receipts marker
             ON marker.command_id = json_extract(pending.payload_json, '$.markerCommandId')
           WHERE pending.aggregate_type = 'hosted-site-terminal'
             AND pending.event_type = 'hosted-site.terminal-pending'
             AND marker.command_id IS NULL
           ORDER BY pending.sequence`,
        )
        .all(),
    )) {
      const event = pendingHostedSiteTerminalEventValue(JSON.parse(requiredStringColumn(row, "payload_json")));
      if (event) pending.push(event);
    }
    return pending;
  }

  deletePendingHostedSiteTerminalEvent(
    botId: string,
    operationId: string,
    status: Exclude<HostedSiteConversationEventStatus, "running">,
  ): void {
    const commandId = `hosted-site-terminal-pending:${botId}:${operationId}:${status}`;
    this.#core.deleteEventsAndReceipt(commandId);
  }

  recordActiveHostedSiteConversationEvent(event: ActiveHostedSiteConversationEvent): void {
    validateActiveHostedSiteConversationEvent(event);
    this.#core.dispatch(
      `hosted-site-active:${event.botId}:${event.event.operationId}`,
      [
        {
          aggregateType: "hosted-site-operation",
          aggregateId: event.botId,
          eventType: "hosted-site.active",
          occurredAt: event.createdAt,
          payload: event,
        },
      ],
      () => null,
    );
  }

  deleteActiveHostedSiteConversationEvent(botId: string, operationId: string): void {
    this.#core.deleteEventsAndReceipt(`hosted-site-active:${botId}:${operationId}`);
  }

  activeHostedSiteConversationEvents(): ActiveHostedSiteConversationEvent[] {
    const active: ActiveHostedSiteConversationEvent[] = [];
    for (const row of databaseRows(
      this.#core.connection
        .prepare(
          `SELECT payload_json FROM orchestration_events
           WHERE aggregate_type = 'hosted-site-operation' AND event_type = 'hosted-site.active'
           ORDER BY sequence`,
        )
        .all(),
    )) {
      const event = activeHostedSiteConversationEventValue(JSON.parse(requiredStringColumn(row, "payload_json")));
      if (event) active.push(event);
    }
    return active;
  }
}

function validatePendingHostedSiteTerminalEvent(event: PendingHostedSiteTerminalEvent): void {
  if (!pendingHostedSiteTerminalEventValue(event)) {
    throw new Error("The pending hosted site terminal event is invalid.");
  }
}

function validateActiveHostedSiteConversationEvent(event: ActiveHostedSiteConversationEvent): void {
  if (!activeHostedSiteConversationEventValue(event)) {
    throw new Error("The active hosted site event is invalid.");
  }
}

function activeHostedSiteConversationEventValue(value: unknown): ActiveHostedSiteConversationEvent | null {
  if (
    !isDynamicRecord(value) ||
    !isString(value.botId) ||
    !value.botId ||
    !isString(value.threadId) ||
    !value.threadId ||
    !isString(value.turnId) ||
    !value.turnId ||
    !isString(value.createdAt) ||
    !isDynamicRecord(value.event) ||
    (value.event.action !== "publish" && value.event.action !== "replace" && value.event.action !== "delete") ||
    value.event.status !== "running" ||
    !isString(value.event.operationId)
  ) {
    return null;
  }
  const marker = hostedSiteConversationEvent({
    id: `hosted-site-event:${value.event.operationId}:running`,
    author: "system",
    source: "system",
    text: JSON.stringify({
      siteId: value.event.siteId,
      title: value.event.title,
      hostname: value.event.hostname,
      url: value.event.url,
    }),
    createdAt: value.createdAt,
    status: "completed",
    itemType: `hosted-site-event:${value.event.action}:running:${value.event.operationId}`,
  });
  if (marker?.status !== "running") return null;
  return {
    botId: value.botId,
    threadId: value.threadId,
    turnId: value.turnId,
    createdAt: value.createdAt,
    event: { ...marker, status: "running" },
  };
}

function pendingHostedSiteTerminalEventValue(value: unknown): PendingHostedSiteTerminalEvent | null {
  if (
    !isDynamicRecord(value) ||
    !isString(value.botId) ||
    !value.botId ||
    !isString(value.threadId) ||
    !value.threadId ||
    !isString(value.turnId) ||
    !value.turnId ||
    !isString(value.operationId) ||
    (value.action !== "publish" && value.action !== "replace" && value.action !== "delete") ||
    (value.status !== "succeeded" &&
      value.status !== "failed" &&
      value.status !== "interrupted" &&
      value.status !== "cancelled") ||
    !isDynamicRecord(value.details) ||
    !isString(value.markerCommandId) ||
    !isString(value.createdAt)
  ) {
    return null;
  }
  const marker = hostedSiteConversationEvent({
    id: value.markerCommandId,
    author: "system",
    source: "system",
    text: JSON.stringify(value.details),
    createdAt: value.createdAt,
    status: "completed",
    itemType: `hosted-site-event:${value.action}:${value.status}:${value.operationId}`,
  });
  if (!marker || marker.status === "running") return null;
  if (value.markerCommandId !== `hosted-site-event:${value.botId}:${value.operationId}:${value.status}`) return null;
  return {
    botId: value.botId,
    threadId: value.threadId,
    turnId: value.turnId,
    operationId: marker.operationId,
    action: marker.action,
    status: marker.status,
    details: {
      siteId: marker.siteId,
      title: marker.title,
      hostname: marker.hostname,
      url: marker.url,
    },
    markerCommandId: value.markerCommandId,
    createdAt: value.createdAt,
  };
}
