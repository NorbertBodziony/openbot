import type { CentralAuthUser } from "@openbot/contracts/ipc";
import { createEffect, createMemo, Loading } from "solid-js";
import { useLayout } from "../../layout";
import { AccountDock } from "../../lazy-views";
import { usePlatform } from "../../platform";
import { useAgents } from "../agents/agents-context";
import { useSetup } from "../onboarding/onboarding-context";
import { useServers } from "../servers/servers-context";
import { useSettings } from "../settings/settings-context";
import { useUpdates } from "../updates/updates-context";
import { useAuth } from "./account-context";
import { StaticAccountDock } from "./StaticAccountDock";

/**
 * The signed-in account, its usage and the update state, at the bottom of the
 * left column. `StaticAccountDock` is the fallback rather than a spinner because
 * this sits at a fixed place in the frame: a placeholder of a different height
 * would move the sidebar above it while the chunk loads.
 */
export function WorkspaceAccountDock(props: { account: () => CentralAuthUser }) {
  const platform = usePlatform();
  const layout = useLayout();
  const auth = useAuth();
  const setup = useSetup();
  const updates = useUpdates();
  const { activeAgent, agentStatus } = useAgents();
  const { activeServerId, activeServerSupportsCapability } = useServers();
  const { openAppSettings, setSkillsMarketplaceOpen } = useSettings();
  const usageReady = createMemo(() => {
    const agent = activeAgent();
    if (!agent || agentStatus().phase !== "ready") return false;
    const provider = agentStatus().providers?.find((candidate) => candidate.id === agent.provider);
    return provider ? provider.state === "available" && provider.connectionState !== "connecting" : true;
  });
  const usageTargetKey = createMemo(() => {
    const agent = activeAgent();
    if (!agent || !usageReady() || !activeServerSupportsCapability("model-scoped-usage")) return null;
    return JSON.stringify([activeServerId(), agent.provider, agent.model]);
  });

  createEffect(
    () => usageTargetKey(),
    (targetKey) => auth.selectAccountUsageTarget(targetKey),
  );

  return (
    <Loading
      fallback={
        <StaticAccountDock
          account={props.account()}
          compact={layout.leftPanelCompact()}
          hybrid={platform.appInfo()?.platform === "darwin" && !layout.leftPanelCompact()}
          withServerRail={platform.serverRailVisible()}
        />
      }
    >
      <AccountDock
        account={props.account()}
        appInfo={platform.appInfo()}
        agentStatus={agentStatus()}
        accountUsage={auth.accountUsage()}
        usageTargetKey={usageTargetKey()}
        usageRefreshRevision={auth.accountUsageRefreshRevision()}
        usageReady={usageReady()}
        updateStatus={updates.status()}
        compact={layout.leftPanelCompact()}
        withServerRail={platform.serverRailVisible()}
        onRefreshUsage={() => {
          const agent = activeAgent();
          const targetKey = usageTargetKey();
          return agent && targetKey ? auth.refreshAccountUsage(agent.id, targetKey) : Promise.resolve({ limits: [] });
        }}
        onUpdateAction={updates.runAction}
        onLogout={platform.landingPreview ? undefined : auth.logoutCentralAccount}
        onOpenExternal={(destination) => window.openbot.openExternal(destination)}
        onOpenPermissions={() => setup.setPermissionsOpen(true)}
        onOpenSettings={openAppSettings}
        onOpenSkills={() => setSkillsMarketplaceOpen(true)}
      />
    </Loading>
  );
}
