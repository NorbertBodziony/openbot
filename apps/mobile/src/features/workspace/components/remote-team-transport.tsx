import type { AgentEvent, TeamRealtimeEvent } from "@openbot/contracts/ipc";
import type { TeamProtocolV2Json } from "@openbot/contracts/team-protocol/v2";
import type { RemoteTeamDirectoryClient } from "@openbot/team-client";
import {
  createRemoteCommandMailbox,
  type RemoteTeamCommand,
  type RemoteTeamCommandResult,
  type RemoteTeamConnectionUpdate,
} from "@openbot/team-client/remote-peer";
import * as Crypto from "expo-crypto";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";

import RemoteTeamBridge from "./remote-team-bridge.dom";

export interface RemoteTeamTransportRef {
  connect(hostId: string, hostPublicKey: string): Promise<void>;
  disconnect(): Promise<void>;
  request<T>(method: string, path: string, decode: (value: unknown) => T, body?: TeamProtocolV2Json): Promise<T>;
}

interface RemoteTeamTransportProps {
  active: boolean;
  directory: RemoteTeamDirectoryClient;
  onConnectionUpdate: (update: RemoteTeamConnectionUpdate) => void;
  onTeamEvent: (hostId: string, event: AgentEvent | TeamRealtimeEvent) => void;
}

type RemoteTeamCommandInput =
  | { type: "connect"; hostId: string; hostPublicKey: string }
  | { type: "disconnect" }
  | { type: "request"; method: string; path: string; body: TeamProtocolV2Json };

export const RemoteTeamTransport = forwardRef<RemoteTeamTransportRef, RemoteTeamTransportProps>(
  function RemoteTeamTransport({ active: foreground, directory, onConnectionUpdate, onTeamEvent }, ref) {
    const [commands, setCommands] = useState<RemoteTeamCommand[]>([]);
    const mailboxRef = useRef<ReturnType<typeof createRemoteCommandMailbox> | null>(null);
    if (!mailboxRef.current) mailboxRef.current = createRemoteCommandMailbox(setCommands);
    const mailbox = mailboxRef.current;
    useEffect(() => () => mailbox.dispose(), [mailbox]);

    const enqueue = useCallback(
      (next: RemoteTeamCommandInput): Promise<RemoteTeamCommandResult> => {
        const id = Crypto.randomUUID();
        const command: RemoteTeamCommand =
          next.type === "connect"
            ? { id, type: "connect", hostId: next.hostId, hostPublicKey: next.hostPublicKey }
            : next.type === "request"
              ? { id, type: "request", method: next.method, path: next.path, body: next.body }
              : { id, type: "disconnect" };
        return mailbox.send(command);
      },
      [mailbox],
    );

    useImperativeHandle(
      ref,
      () => ({
        connect: async (hostId, hostPublicKey) => {
          const result = await enqueue({ type: "connect", hostId, hostPublicKey });
          if (!result.ok) throw new Error(result.error ?? "The server connection failed.");
        },
        disconnect: async () => {
          const result = await enqueue({ type: "disconnect" });
          if (!result.ok) throw new Error(result.error ?? "The server did not disconnect cleanly.");
        },
        request: async <T,>(
          method: string,
          path: string,
          decode: (value: unknown) => T,
          body: TeamProtocolV2Json = {},
        ): Promise<T> => {
          const result = await enqueue({ type: "request", method, path, body });
          if (!result.ok) throw new Error(result.error ?? "The server request failed.");
          if (result.status !== undefined && result.status >= 400) throw new Error("The server request failed.");
          return decode(result.body);
        },
      }),
      [enqueue],
    );

    const handleCommandResult = useCallback(
      async (result: RemoteTeamCommandResult) => {
        mailbox.receive(result);
      },
      [mailbox],
    );

    return (
      <RemoteTeamBridge
        active={foreground}
        commands={commands}
        dom={{
          containerStyle: {
            flex: 0,
            height: 1,
            left: 0,
            opacity: 0,
            position: "absolute",
            top: 0,
            width: 1,
          },
          pointerEvents: "none",
          scrollEnabled: false,
          style: { flex: 0, height: 1, width: 1 },
        }}
        endSession={(sessionId) => directory.endSession(sessionId)}
        getBootstrap={(hostId, clientPublicKey) => directory.createBootstrap(hostId, clientPublicKey)}
        onCommandResult={handleCommandResult}
        onConnectionUpdate={async (update) => onConnectionUpdate(update)}
        onTeamEvent={async (hostId, event) => onTeamEvent(hostId, event)}
      />
    );
  },
);
