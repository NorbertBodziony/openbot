import { createEffect, flush, onSettled } from "solid-js";
import { DynamicIslandCoordinator } from "./dynamic-island-coordinator";
import { usePlatform } from "./platform";
import { useServers } from "./servers";
import { createSimpleContext } from "./simple-context";

/**
 * The macOS Dynamic Island projection: what the desktop shows about servers the
 * user is *not* looking at.
 *
 * This is the one domain that is deliberately cross-server, so it sits above
 * everything per-server. `DynamicIslandCoordinator` keeps a runtime per server
 * id and hands the six turn signals back on a switch (`serverState(serverId)`),
 * which is why it must outlive any subtree keyed by the active server.
 * `onScopedEvent` is the other half of that: events for a background server
 * arrive here and nowhere else, because no per-server domain exists to receive
 * them.
 *
 * Publishing is batched through `queueMicrotask` rather than an effect. Several
 * of the callers below fire in the same flush - a scoped event, the retain
 * effect, a resolved action - and main only needs the last presentation, so the
 * scheduled flag collapses them into one IPC call.
 *
 * The coordinator itself is exposed rather than wrapped. Its three remaining
 * callers (`serverState` on a switch, `replaceServer` from the projection
 * effect, `resolveAction` from the action handler) each still live outside this
 * module, and a wrapper per call would only re-declare their signatures.
 */
const DynamicIsland = createSimpleContext({
  name: "Dynamic Island",
  init: () => {
    const platform = usePlatform();
    const { servers, activeServerId } = useServers();
    const coordinator = new DynamicIslandCoordinator();
    const connectedServers = new Set(["local"]);
    let presentationScheduled = false;

    /** Active server first: main renders the head of this list as the leading item. */
    function serverOrder(): string[] {
      const activeId = activeServerId();
      const ids = servers()
        .filter((server) => connectedServers.has(server.id) && (server.kind === "local" || server.state === "online"))
        .map((server) => server.id);
      ids.sort((left, right) => Number(right === activeId) - Number(left === activeId));
      return ids.length > 0 ? ids : ["local"];
    }

    function publishPresentation(): void {
      if (platform.landingPreview || presentationScheduled) return;
      presentationScheduled = true;
      queueMicrotask(() => {
        presentationScheduled = false;
        const presentation = coordinator.presentation(serverOrder());
        void window.openbot.dynamicIsland.publishPresentation(presentation).catch(() => undefined);
      });
    }

    createEffect(
      () =>
        servers()
          .map((server) => `${server.id}:${server.state}`)
          .join("\u0000"),
      () => {
        const currentServers = servers();
        const configuredServerIds = new Set(currentServers.map((server) => server.id));
        for (const serverId of connectedServers) {
          const server = currentServers.find((candidate) => candidate.id === serverId);
          if (!configuredServerIds.has(serverId) || (server?.kind === "remote" && server.state !== "online")) {
            connectedServers.delete(serverId);
          }
        }
        connectedServers.add("local");
        coordinator.retainServers([...configuredServerIds]);
        publishPresentation();
      },
    );

    onSettled(() =>
      window.openbot.agent.onScopedEvent((event) => {
        flush(() => {
          const server = servers().find((candidate) => candidate.id === event.serverId);
          if (server?.kind === "remote" && server.state !== "online") return;
          connectedServers.add(event.serverId);
          coordinator.applyEvent(event, activeServerId());
          publishPresentation();
        });
      }),
    );

    return {
      dynamicIslandCoordinator: coordinator,
      publishDynamicIslandPresentation: publishPresentation,
    };
  },
});

export const DynamicIslandProvider = DynamicIsland.provider;
export const useDynamicIsland = DynamicIsland.use;
