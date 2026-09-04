import type { CentralAuthUser } from "@openbot/contracts/ipc";
import { createEffect, createMemo, Loading } from "solid-js";
import { useAgents } from "./agents";
import { useAuth } from "./auth";
import { StaticAccountDock } from "./components/StaticAccountDock";
import { useLayout } from "./layout";
import { AccountDock } from "./lazy-views";
import { usePlatform } from "./platform";
import { useServers } from "./servers";
import { useSettings } from "./settings";
import { useSetup } from "./setup";
import { useUpdates } from "./updates";

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
  const { activeBot, agentStatus } = useAgents();
  const { activeServerId, activeServerSupportsCapability } = useServers();
  const { openAppSettings, setSkillsMarketplaceOpen } = useSettings();
  const usageReady = createMemo(() => {
    const bot = activeBot();
    if (!bot || agentStatus().phase !== "ready") return false;
    const provider = agentStatus().providers?.find((candidate) => candidate.id === bot.provider);
    return provider ? provider.state === "available" : true;
  });
  const usageTargetKey = createMemo(() => {
    const bot = activeBot();
    if (!bot || !usageReady() || !activeServerSupportsCapability("model-scoped-usage")) return null;
    return JSON.stringify([activeServerId(), bot.provider, bot.model]);
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
          const bot = activeBot();
          const targetKey = usageTargetKey();
          return bot && targetKey ? auth.refreshAccountUsage(bot.id, targetKey) : Promise.resolve({ limits: [] });
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
