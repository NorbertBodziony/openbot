import type { TeamPresenceSnapshot } from "@openbot/contracts/ipc";
import { createMemo, createSignal, flush, onSettled } from "solid-js";
import { EMPTY_TEAM_PRESENCE } from "../../app-defaults";
import { createSimpleContext } from "../../simple-context";
import { useAuth } from "../account/account-context";

/**
 * Who else is on the active workspace, and which of them is the signed-in user.
 *
 * The identity match runs on email or username rather than an id because
 * presence is the team server's view of its members and the account is the cloud
 * service's view of one person; nothing joins them but the address the user
 * signed in with. A signed-out user therefore has no current member, which is
 * also what makes `directPeople` empty - a list of people to message is
 * meaningless without a "me" to exclude from it.
 *
 * The snapshot itself is per server, but the read that seeds it is one of the
 * eight the workspace bootstrap and `selectServer` both run, so the *load* stays
 * with whoever owns that sequence and only the state lives here. That is why
 * `setTeamPresence` is exported: the server switch clears it and the bootstrap
 * fills it. Both callers disappear once the per-server scope owns its own init.
 *
 * `activeDirectMember` is deliberately not here. It reads the selected member,
 * and selection sits under this domain.
 */
const Presence = createSimpleContext({
  name: "Presence",
  init: () => {
    const { centralAuth } = useAuth();
    const [teamPresence, setTeamPresence] = createSignal<TeamPresenceSnapshot>(EMPTY_TEAM_PRESENCE);

    const currentTeamMember = createMemo(() => {
      const state = centralAuth();
      if (state.status !== "signed_in") return undefined;
      const email = state.user.email.trim().toLowerCase();
      return teamPresence().members.find(
        (member) => member.email?.trim().toLowerCase() === email || member.username.trim().toLowerCase() === email,
      );
    });

    const directPeople = createMemo(() => {
      const currentMemberId = currentTeamMember()?.id;
      if (!currentMemberId) return [];
      return teamPresence().members.filter((member) => member.id !== currentMemberId && !member.disabled);
    });

    onSettled(() => window.openbot.servers.onPresence((snapshot) => flush(() => setTeamPresence(snapshot))));

    return { teamPresence, setTeamPresence, currentTeamMember, directPeople };
  },
});

export const PresenceProvider = Presence.provider;
export const usePresence = Presence.use;
