import { Show } from "solid-js";
import { ServerRail } from "./components/ServerRail";
import { toast } from "./components/ui";
import { usePlatform } from "./platform";
import { useServerSelection } from "./server-selection";
import { useServerSettings } from "./server-settings";
import { useServers } from "./servers";

/**
 * The rail of team servers down the left edge, and the platform test for
 * whether there is one at all. The test lives here rather than in the shell
 * because the rail is the thing it decides about; the shell only needs to know
 * that the frame has to leave room, which it asks `serverRailVisible` itself.
 */
export function WorkspaceServerRail() {
  const platform = usePlatform();
  const { servers, reorderServers, setJoinServerOpen } = useServers();
  const { selectServer } = useServerSelection();
  const { openServerSettings } = useServerSettings();

  return (
    <Show when={platform.serverRailVisible()}>
      <ServerRail
        servers={servers()}
        onSelect={(serverId) =>
          void selectServer(serverId).catch((error) => {
            toast.error("Could not select the server", {
              description: error instanceof Error ? error.message : String(error),
            });
          })
        }
        onReorder={(serverIds) => void reorderServers(serverIds)}
        onAdd={() => {
          if (!platform.landingPreview) setJoinServerOpen(true);
        }}
        onOpenSettings={openServerSettings}
      />
    </Show>
  );
}
