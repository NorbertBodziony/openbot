"use dom";

import {
  createRemoteTeamPeer,
  type RemoteTeamCommand,
  type RemoteTeamCommandResult,
  type RemoteTeamPeerActions,
} from "@openbot/team-client/remote-peer";
import { useEffect, useRef } from "react";

interface RemoteTeamBridgeProps extends RemoteTeamPeerActions {
  commands: RemoteTeamCommand[];
  active: boolean;
  onCommandResult: (result: RemoteTeamCommandResult) => Promise<void>;
  dom?: import("expo/dom").DOMProps;
}

export default function RemoteTeamBridge({ commands, active, onCommandResult, ...callbacks }: RemoteTeamBridgeProps) {
  const actions = useRef(callbacks);
  actions.current = callbacks;
  const runtime = useRef<ReturnType<typeof createRemoteTeamPeer> | null>(null);
  if (!runtime.current) runtime.current = createRemoteTeamPeer(actions);
  const peer = runtime.current;
  const processedCommandIds = useRef(new Set<string>());

  useEffect(() => {
    peer.setActive(active);
  }, [active, peer]);

  useEffect(() => {
    const currentIds = new Set(commands.map((command) => command.id));
    for (const id of processedCommandIds.current) {
      if (!currentIds.has(id)) processedCommandIds.current.delete(id);
    }
    for (const command of commands) {
      if (processedCommandIds.current.has(command.id)) continue;
      processedCommandIds.current.add(command.id);
      void peer.execute(command).then(onCommandResult);
    }
  }, [commands, onCommandResult, peer]);

  useEffect(
    () => () => {
      void peer.dispose();
    },
    [peer],
  );
  return null;
}
