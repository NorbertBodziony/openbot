import type { InstalledSkill } from "@openbot/contracts/ipc";
import { createEffect, createMemo, createSignal, untrack } from "solid-js";
import type { ConversationProps } from "../../ConversationView";
import { installedSkillsRequestKey } from "../installed-skills-source";

export interface SkillsStoreDeps {
  props: ConversationProps;
}

export function createSkillsStore(deps: SkillsStoreDeps) {
  const [installedSkills, setInstalledSkills] = createSignal<InstalledSkill[]>([]);
  const [installedSkillsRetry, setInstalledSkillsRetry] = createSignal(0);
  let installedSkillsRequest = 0;
  let installedSkillsSourceId: string | undefined;
  let failedInstalledSkillsAttempt: { serverId: string; sourceId: string; connectionSequence: number } | undefined;
  const installedSkillsSource = createMemo(() =>
    installedSkillsRequestKey(deps.props.agent?.id, deps.props.server, deps.props.skillsMarketplaceOpen === true),
  );
  createEffect(
    () => `${deps.props.server?.id ?? "local"}\0${deps.props.server?.connectionSequence ?? 0}`,
    (source) => {
      const [serverId, connectionSequenceText] = source.split("\0");
      const failedAttempt = failedInstalledSkillsAttempt;
      if (
        failedAttempt?.serverId === serverId &&
        failedAttempt.sourceId === `${serverId}\0${untrack(() => deps.props.agent?.id) ?? ""}` &&
        failedAttempt.connectionSequence !== Number(connectionSequenceText)
      ) {
        setInstalledSkillsRetry((retry) => retry + 1);
      }
    },
  );
  createEffect(
    () => `${installedSkillsSource()}\0${installedSkillsRetry()}`,
    (source) => {
      const request = ++installedSkillsRequest;
      const [serverId, agentId, support, visibility] = source.split("\0");
      if (!agentId) {
        installedSkillsSourceId = undefined;
        failedInstalledSkillsAttempt = undefined;
        setInstalledSkills([]);
        return;
      }
      if (visibility === "hidden") return;
      const sourceId = `${serverId}\0${agentId}`;
      if (installedSkillsSourceId !== sourceId) {
        installedSkillsSourceId = sourceId;
        setInstalledSkills([]);
      }
      if (support === "unsupported") {
        failedInstalledSkillsAttempt = undefined;
        setInstalledSkills([]);
        return;
      }
      const connectionSequence = untrack(() => deps.props.server?.connectionSequence) ?? 0;
      failedInstalledSkillsAttempt = undefined;
      void window.openbot.agent
        .listInstalledSkills(agentId)
        .then((skills) => {
          if (request !== installedSkillsRequest) return;
          failedInstalledSkillsAttempt = undefined;
          setInstalledSkills(skills);
        })
        .catch(() => {
          if (request !== installedSkillsRequest) return;
          failedInstalledSkillsAttempt = { serverId, sourceId, connectionSequence };
          // Preserve an already loaded same-agent catalog when a refresh fails.
        });
    },
  );

  return {
    installedSkills,
  };
}

export type SkillsStore = ReturnType<typeof createSkillsStore>;
