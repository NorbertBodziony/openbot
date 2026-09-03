"use dom";

import {
  createRemoteTeamPeer,
  type RemoteTeamCommand,
  type RemoteTeamCommandResult,
  type RemoteTeamPeerActions,
} from "@openbot/team-client/remote-peer";
import { useEffect, useRef } from "react";

interface RemoteTeamBridgeProps extends RemoteTeamPeerActions {
  command: RemoteTeamCommand | null;
  active: boolean;
  onCommandResult: (result: RemoteTeamCommandResult) => Promise<void>;
  dom?: import("expo/dom").DOMProps;
}

export default function RemoteTeamBridge({ command, active, onCommandResult, ...callbacks }: RemoteTeamBridgeProps) {
  const actions = useRef(callbacks);
  actions.current = callbacks;
  const runtime = useRef<ReturnType<typeof createRemoteTeamPeer> | null>(null);
  if (!runtime.current) runtime.current = createRemoteTeamPeer(actions);
  const peer = runtime.current;
  const processedCommandId = useRef<string | null>(null);

  useEffect(() => {
    peer.setActive(active);
  }, [active, peer]);

  useEffect(() => {
    if (!command || processedCommandId.current === command.id) return;
    processedCommandId.current = command.id;
    void peer.execute(command).then(onCommandResult);
  }, [command, onCommandResult, peer]);

  useEffect(
    () => () => {
      void peer.dispose();
    },
    [peer],
  );
  return null;
}
