import type { DynamicIslandAction } from "@openbot/contracts/ipc";
import { createSignal } from "solid-js";
import { createSimpleContext } from "./simple-context";

/**
 * The handful of things that describe a *transition* between two server scopes,
 * and therefore cannot live in either of them.
 *
 * Everything per-server hangs under a subtree keyed by the active server id, so
 * it is created and disposed by the switch. That leaves three values with the
 * opposite lifetime - they are written by the scope being left and read by the
 * scope being entered - and this is where they live:
 *
 * - `browserVisibilitySuspended` hides the native browser view for the length of
 *   a switch. It used to sit in `browser-tabs.tsx`, where it happened to survive
 *   because nothing was ever torn down; under a keyed scope it would be cleared
 *   by the very unmount it exists to cover.
 * - `pendingBotSelection` carries "select this agent once you are on that
 *   server" across the remount, for an agent opened from the marketplace.
 * - `pendingIslandAction` does the same for a Dynamic Island action, which
 *   arrives for *any* server and so may have to switch before it can act. The
 *   whole action is republished rather than a fragment of it, so the scope that
 *   lands runs the identical handler with its own domains.
 *
 * Deliberately dependency-free, so it can be mounted anywhere above the scope.
 */
/**
 * The Dynamic Island actions that name a server, and so may have to wait for one
 * to be mounted. The three that do not - opening the app, answering a prompt and
 * responding to an approval - resolve against the coordinator wherever the user
 * happens to be, so they are never handed across a switch.
 */
type ServerScopedIslandAction = Extract<DynamicIslandAction, { serverId: string }>;

const ServerSwitch = createSimpleContext({
  name: "Server switch",
  init: () => {
    const [browserVisibilitySuspended, setBrowserVisibilitySuspended] = createSignal(false);
    const [pendingBotSelection, setPendingBotSelection] = createSignal<string | null>(null);
    const [pendingIslandAction, setPendingIslandAction] = createSignal<ServerScopedIslandAction | null>(null);
    return {
      browserVisibilitySuspended,
      setBrowserVisibilitySuspended,
      pendingBotSelection,
      setPendingBotSelection,
      pendingIslandAction,
      setPendingIslandAction,
    };
  },
});

export const ServerSwitchProvider = ServerSwitch.provider;
export const useServerSwitch = ServerSwitch.use;
