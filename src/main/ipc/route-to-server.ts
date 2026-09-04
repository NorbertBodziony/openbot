// One agent-scoped channel, two backends: the local `AgentService` or a remote team server over
// HTTP. Every handler that takes a `serverId` has to pick, and the pick was written out by hand at
// 54 call sites - a ternary on `serverId === "local"` whose two arms were far enough apart to read
// as two handlers. The branch is the same shape every time, so it gets one name.
//
// Either arm may be synchronous - a local store read, or presence the server manager already holds -
// so both are normalized with `Promise.resolve`. That is invisible at the IPC boundary, which
// promisifies a handler's result either way.

import { LOCAL_SERVER_ID } from "@openbot/contracts/ipc";

export function routeToServer<T>(
  serverId: string,
  branches: { local: () => T | Promise<T>; remote: (serverId: string) => T | Promise<T> },
): Promise<T> {
  return Promise.resolve(serverId === LOCAL_SERVER_ID ? branches.local() : branches.remote(serverId));
}
