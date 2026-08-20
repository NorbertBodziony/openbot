import type { ServerSummary } from "@openbot/contracts/ipc";
import { For, Show } from "solid-js";
import { Button, ContextMenu } from "./ui";

interface ServerRailProps {
  platform: "darwin" | "win32" | "linux";
  servers: ServerSummary[];
  onSelect: (serverId: string) => void;
  onAdd: () => void;
  onOpenHost: () => void;
  onOpenRemoteMac: () => void;
}

export function ServerRail(props: ServerRailProps) {
  const activeRemote = () => props.servers.find((server) => server.active && server.kind === "remote");
  return (
    <aside class="server-rail panel-edge" aria-label="Servers">
      <div class="server-rail-list">
        <For each={props.servers}>
          {(server) => (
            <Show
              when={server.kind === "local"}
              fallback={
                <Button
                  type="button"
                  class={["server-rail-button", { "server-rail-button-active": server.active }]}
                  aria-label={`${server.name} server${server.state === "online" ? "" : `, ${server.state}`}`}
                  aria-pressed={server.active ? "true" : "false"}
                  title={server.name}
                  onClick={() => props.onSelect(server.id)}
                >
                  <span class="server-rail-mark" />
                  <span class="server-rail-monogram">{initials(server.name)}</span>
                  <span class={`server-rail-state server-rail-state-${server.state}`} />
                </Button>
              }
            >
              <ContextMenu.Root modal={false}>
                <ContextMenu.Trigger
                  as={Button}
                  type="button"
                  class={["server-rail-button", { "server-rail-button-active": server.active }]}
                  aria-label={`${server.name} server${server.state === "online" ? "" : `, ${server.state}`}`}
                  aria-pressed={server.active ? "true" : "false"}
                  title={server.name}
                  onClick={() => props.onSelect(server.id)}
                >
                  <span class="server-rail-mark" />
                  <span class="server-rail-local">O</span>
                  <span class={`server-rail-state server-rail-state-${server.state}`} />
                </ContextMenu.Trigger>
                <ContextMenu.Portal>
                  <ContextMenu.Content class="bot-context-menu" aria-label="Server actions">
                    <ContextMenu.Item onSelect={props.onOpenHost}>
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 20 20"
                        class="bot-context-icon"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.35"
                      >
                        <rect x="3" y="3" width="14" height="5" rx="1.5" />
                        <rect x="3" y="12" width="14" height="5" rx="1.5" />
                        <circle cx="6" cy="5.5" r=".8" />
                        <circle cx="6" cy="14.5" r=".8" />
                      </svg>
                      <span>Publish this OpenBot</span>
                    </ContextMenu.Item>
                  </ContextMenu.Content>
                </ContextMenu.Portal>
              </ContextMenu.Root>
            </Show>
          )}
        </For>
        <Button
          type="button"
          class="server-rail-button server-rail-action"
          aria-label="Add remote server"
          title="Add remote server"
          onClick={props.onAdd}
        >
          <span class="server-rail-monogram">+</span>
        </Button>
      </div>
      <Show when={props.platform === "darwin" && activeRemote()}>
        <div class="server-rail-tools">
          <Button
            type="button"
            class="server-rail-button server-rail-action"
            aria-label="Open Remote Mac"
            title="Remote Mac"
            onClick={props.onOpenRemoteMac}
          >
            <svg aria-hidden="true" viewBox="0 0 20 20">
              <rect x="3" y="4" width="14" height="10" rx="2" />
              <path d="M7 17h6M10 14v3" />
            </svg>
          </Button>
        </div>
      </Show>
    </aside>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}
