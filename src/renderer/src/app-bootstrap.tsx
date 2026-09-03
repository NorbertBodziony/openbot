import { createEffect, flush, onSettled } from "solid-js";
import { useAuth } from "./auth";
import { useServers } from "./servers";
import { useSetup } from "./setup";

/**
 * The deep-link invite, and nothing else.
 *
 * This used to hold the first per-server load and the two window listeners as
 * well. Both moved into `server-scope.tsx` when the per-server state became a
 * keyed subtree: the load because first mount and server switch are now the same
 * mount, and the listeners because both read scoped state.
 *
 * What is left genuinely belongs above that boundary. An invite can arrive
 * before any server exists, has to survive the switch it causes, and spans
 * setup, auth and servers - so it is registered once, for the life of the
 * window.
 */
export function AppBootstrap() {
  const { centralAuth } = useAuth();
  const { setupState, pendingInviteUrl, setPendingInviteUrl } = useSetup();
  const { setJoinServerOpen } = useServers();

  onSettled(() => {
    const receiveInvite = (inviteUrl: string) => {
      flush(() => {
        setPendingInviteUrl(inviteUrl);
        if (setupState()?.completed === true && centralAuth().status === "signed_in") setJoinServerOpen(true);
      });
    };
    const unsubscribeInvite = window.openbot.servers.onInvite((inviteUrl) => {
      receiveInvite(inviteUrl);
    });
    void window.openbot.servers
      .takePendingInvite()
      .then((inviteUrl) => inviteUrl && receiveInvite(inviteUrl))
      .catch(() => undefined);
    return unsubscribeInvite;
  });

  createEffect(
    () => ({
      inviteUrl: pendingInviteUrl(),
      setupCompleted: setupState()?.completed === true,
      signedIn: centralAuth().status === "signed_in",
    }),
    ({ inviteUrl, setupCompleted, signedIn }) => {
      if (inviteUrl && setupCompleted && signedIn) {
        setJoinServerOpen(true);
      }
    },
  );

  return null;
}
