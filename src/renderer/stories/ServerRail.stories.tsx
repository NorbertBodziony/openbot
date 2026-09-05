import { createMemo, createSignal } from "solid-js";
import { expect, fireEvent, fn, userEvent, waitFor, within } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { ServerRail } from "../src/features/servers/ServerRail";
import { STORY_SERVERS } from "./fixtures";

const args: Parameters<typeof ServerRail>[0] = {
  servers: STORY_SERVERS,
  onSelect: fn(),
  onReorder: fn(),
  onAdd: fn(),
  onOpenSettings: fn(),
};

const MANY_SERVERS = createManyServers();

function createManyServers() {
  const local = STORY_SERVERS.find((server) => server.kind === "local");
  const remote = STORY_SERVERS.find((server) => server.kind === "remote");
  if (!local || !remote) return STORY_SERVERS;
  return [
    local,
    ...Array.from({ length: 16 }, (_, index) => ({
      ...remote,
      id: `remote-${index + 1}`,
      name: `Remote server ${index + 1}`,
      active: false,
      logoUrl: null,
    })),
  ];
}

function InteractiveServerRail(props: Parameters<typeof ServerRail>[0]) {
  const [activeServerOverride, setActiveServerOverride] = createSignal<string>();
  const [serverOrder, setServerOrder] = createSignal(props.servers.map((server) => server.id));
  const activeServerId = createMemo(
    () => activeServerOverride() ?? props.servers.find((server) => server.active)?.id ?? props.servers[0]?.id,
  );
  const storyServers = createMemo(() =>
    serverOrder().flatMap((serverId) => {
      const server = props.servers.find((candidate) => candidate.id === serverId);
      return server ? [{ ...server, active: server.id === activeServerId() }] : [];
    }),
  );
  return (
    <ServerRail
      servers={storyServers()}
      onSelect={(serverId) => {
        setActiveServerOverride(serverId);
        props.onSelect(serverId);
      }}
      onReorder={(serverIds) => {
        setServerOrder([
          ...props.servers.filter((server) => server.kind === "local").map((server) => server.id),
          ...serverIds,
        ]);
        props.onReorder(serverIds);
      }}
      onAdd={props.onAdd}
      onOpenSettings={props.onOpenSettings}
    />
  );
}

const meta = {
  title: "Navigation/ServerRail",
  component: ServerRail,
  render: (storyArgs) => <InteractiveServerRail {...storyArgs} />,
  args,
  decorators: [(Story) => <div class="app-frame app-frame-with-server-rail">{Story()}</div>],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ServerRail>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {
  play: async ({ canvas }) => {
    const rail = canvas.getByRole("complementary", { name: "Servers" });
    const local = canvas.getByRole("button", { name: "Local server" });
    const remote = canvas.getByRole("button", { name: "OpenBot team server" });
    const localMarker = local.querySelector<HTMLElement>(".server-rail-mark");
    const remoteMarker = remote.querySelector<HTMLElement>(".server-rail-mark");
    const list = rail.querySelector<HTMLElement>(".server-rail-list");
    const localTile = local.querySelector<HTMLElement>(".ui-server-gradient-logo");
    const dividerStyle = getComputedStyle(rail, "::after");

    await expect(getComputedStyle(rail).borderRightWidth).toBe("0px");
    await expect(dividerStyle.top).toBe("38px");
    await expect(dividerStyle.bottom).toBe("0px");
    if (!localMarker || !remoteMarker || !list) throw new Error("A server rail element is missing");
    await expect(getComputedStyle(localMarker).height).toBe("26px");
    await expect(getComputedStyle(localMarker).opacity).toBe("1");
    await expect(getComputedStyle(remoteMarker).height).toBe("0px");
    await expect(getComputedStyle(remoteMarker).opacity).toBe("0");
    await expect(getComputedStyle(remoteMarker).transitionDuration).toContain("0.16s");
    await expect(localMarker.getBoundingClientRect().left).toBeGreaterThanOrEqual(list.getBoundingClientRect().left);
    await expect(rail.querySelector(".server-rail-state")).not.toBeInTheDocument();
    await expect(local).not.toHaveAttribute("title");
    await expect(remote).not.toHaveAttribute("title");

    const addServer = canvas.getByRole("button", { name: "Add remote server" });
    await expect(addServer).not.toHaveAttribute("title");
    await userEvent.hover(addServer);
    await expect(await within(document.body).findByRole("tooltip")).toHaveTextContent("Add remote server");
    await userEvent.unhover(addServer);
    await waitFor(() => expect(within(document.body).queryByRole("tooltip")).not.toBeInTheDocument());

    if (!localTile) throw new Error("The local server tile is missing");
    const idleButtonStyle = {
      background: getComputedStyle(local).background,
      color: getComputedStyle(local).color,
    };
    const idleStyle = {
      background: getComputedStyle(localTile).background,
      borderRadius: getComputedStyle(localTile).borderRadius,
      color: getComputedStyle(localTile).color,
      transform: getComputedStyle(localTile).transform,
    };

    await userEvent.hover(local);
    const serverTooltip = await within(document.body).findByRole("tooltip");
    await expect(serverTooltip).toHaveTextContent("Local");
    await waitFor(() =>
      expect(serverTooltip.getBoundingClientRect().left).toBeGreaterThan(local.getBoundingClientRect().right),
    );
    await expect(getComputedStyle(local).background).toBe(idleButtonStyle.background);
    await expect(getComputedStyle(local).color).toBe(idleButtonStyle.color);
    await expect(getComputedStyle(localTile).background).toBe(idleStyle.background);
    await expect(getComputedStyle(localTile).borderRadius).toBe(idleStyle.borderRadius);
    await expect(getComputedStyle(localTile).color).toBe(idleStyle.color);
    await expect(getComputedStyle(localTile).transform).toBe(idleStyle.transform);

    await userEvent.unhover(local);
    await waitFor(() => expect(within(document.body).queryByRole("tooltip")).not.toBeInTheDocument());

    local.focus();
    await expect(await within(document.body).findByRole("tooltip")).toHaveTextContent("Local");
    local.blur();
    await waitFor(() => expect(within(document.body).queryByRole("tooltip")).not.toBeInTheDocument());

    await userEvent.hover(remote);
    await waitFor(async () =>
      expect(await within(document.body).findByRole("tooltip")).toHaveTextContent("OpenBot team"),
    );
    await expect(getComputedStyle(localMarker).height).toBe("26px");

    await userEvent.click(remote);
    const selectedRemote = canvas.getByRole("button", { name: "OpenBot team server" });
    const inactiveLocal = canvas.getByRole("button", { name: "Local server" });
    const selectedRemoteMarker = selectedRemote.querySelector<HTMLElement>(".server-rail-mark");
    const inactiveLocalMarker = inactiveLocal.querySelector<HTMLElement>(".server-rail-mark");
    if (!selectedRemoteMarker || !inactiveLocalMarker) throw new Error("A server marker is missing after selection");
    await expect(selectedRemote).toBe(remote);
    await expect(inactiveLocal).toBe(local);
    await expect(selectedRemote).toHaveAttribute("aria-pressed", "true");
    await expect(inactiveLocal).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => expect(getComputedStyle(selectedRemoteMarker).height).toBe("26px"));
    await waitFor(() => expect(getComputedStyle(inactiveLocalMarker).height).toBe("0px"));
    await userEvent.unhover(selectedRemote);
    await waitFor(() => expect(within(document.body).queryByRole("tooltip")).not.toBeInTheDocument());

    await userEvent.click(inactiveLocal);
    const restoredLocal = canvas.getByRole("button", { name: "Local server" });
    const restoredRemote = canvas.getByRole("button", { name: "OpenBot team server" });
    const restoredLocalMarker = restoredLocal.querySelector<HTMLElement>(".server-rail-mark");
    const restoredRemoteMarker = restoredRemote.querySelector<HTMLElement>(".server-rail-mark");
    if (!restoredLocalMarker || !restoredRemoteMarker) throw new Error("A restored server marker is missing");
    await waitFor(() => expect(getComputedStyle(restoredLocalMarker).height).toBe("26px"));
    await waitFor(() => expect(getComputedStyle(restoredRemoteMarker).height).toBe("0px"));
    await userEvent.unhover(restoredLocal);
  },
};

export const OfflineRemote: Story = {
  args: {
    servers: STORY_SERVERS.map((server) =>
      server.kind === "remote" ? { ...server, state: "offline" as const } : server,
    ),
  },
  play: async ({ canvas }) => {
    const rail = canvas.getByRole("complementary", { name: "Servers" });
    await expect(rail.querySelector(".server-rail-state")).not.toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "OpenBot team server, offline" })).toBeInTheDocument();
  },
};

export const ManyServers: Story = {
  args: { servers: MANY_SERVERS },
  play: async ({ canvas }) => {
    const rail = canvas.getByRole("complementary", { name: "Servers" });
    const list = rail.querySelector<HTMLElement>(".server-rail-list");
    if (!list) throw new Error("The server list is missing");

    await expect(getComputedStyle(list).overflowY).toBe("auto");
    await waitFor(() => expect(list.scrollHeight).toBeGreaterThan(list.clientHeight));
    list.scrollTop = list.scrollHeight;
    await waitFor(() => expect(list.scrollTop).toBeGreaterThan(0));
    await expect(canvas.getByRole("button", { name: "Add remote server" })).toBeInTheDocument();
  },
};

export const SortableServers: Story = {
  args: { servers: MANY_SERVERS.slice(0, 4) },
  play: async ({ args: storyArgs, canvas }) => {
    const local = canvas.getByRole("button", { name: "Local server" });
    const first = canvas.getByRole("button", { name: "Remote server 1 server" });
    const remoteList = first.closest<HTMLElement>(".server-rail-remote-list");
    if (!remoteList) throw new Error("The remote server list is missing");

    await expect(local.closest(".server-rail-server-item")).toBeNull();
    await expect(first.closest(".server-rail-server-item")).toHaveAttribute("draggable", "true");
    await expect(first).toHaveAttribute("aria-keyshortcuts", "Alt+ArrowUp Alt+ArrowDown");
    first.focus();
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");

    await waitFor(() => {
      const order = Array.from(remoteList.querySelectorAll<HTMLElement>(".server-rail-server-item")).map(
        (item) => item.dataset.serverId,
      );
      expect(order).toEqual(["remote-2", "remote-1", "remote-3"]);
    });
    await expect(storyArgs.onReorder).toHaveBeenLastCalledWith(["remote-2", "remote-1", "remote-3"]);
    await expect(canvas.getByText("Moved server to position 2 of 3.")).toBeInTheDocument();

    const third = canvas.getByRole("button", { name: "Remote server 3 server" });
    const sourceItem = first.closest<HTMLElement>(".server-rail-server-item");
    const targetItem = third.closest<HTMLElement>(".server-rail-server-item");
    if (!sourceItem || !targetItem) throw new Error("A sortable server item is missing");
    const dataTransfer = new DataTransfer();
    fireEvent.dragStart(sourceItem, { dataTransfer });
    await waitFor(() => expect(sourceItem).toHaveClass("server-rail-server-item-dragging"));
    const targetBounds = targetItem.getBoundingClientRect();
    const targetY = targetBounds.top + targetBounds.height / 2;
    const dragAccepted = fireEvent.dragOver(remoteList, { dataTransfer, clientY: targetY });
    await expect(dragAccepted).toBe(false);
    fireEvent.drop(remoteList, { dataTransfer, clientY: targetY });

    await expect(storyArgs.onReorder).toHaveBeenLastCalledWith(["remote-2", "remote-3", "remote-1"]);
    await expect(getComputedStyle(sourceItem).transitionProperty).toContain("transform");
  },
};

export const AutoScrollServers: Story = {
  args: { servers: MANY_SERVERS },
  play: async ({ canvas }) => {
    const rail = canvas.getByRole("complementary", { name: "Servers" });
    const list = rail.querySelector<HTMLElement>(".server-rail-list");
    const remoteList = rail.querySelector<HTMLElement>(".server-rail-remote-list");
    const first = canvas.getByRole("button", { name: "Remote server 1 server" });
    const sourceItem = first.closest<HTMLElement>(".server-rail-server-item");
    if (!list || !remoteList || !sourceItem) throw new Error("An auto-scroll server rail element is missing");

    list.scrollTop = 0;
    await waitFor(() => expect(list).toHaveClass("scroll-fade-bottom"));
    await expect(list).not.toHaveClass("scroll-fade-top");
    const dataTransfer = new DataTransfer();
    fireEvent.dragStart(sourceItem, { dataTransfer });
    await waitFor(() => expect(sourceItem).toHaveClass("server-rail-server-item-dragging"));
    const listBounds = list.getBoundingClientRect();
    fireEvent.dragOver(remoteList, { dataTransfer, clientY: listBounds.bottom - 1 });

    await waitFor(() => expect(list.scrollTop).toBeGreaterThan(0));
    await expect(list).toHaveClass("scroll-fade-top", "scroll-fade-bottom");
    fireEvent.dragEnd(sourceItem, { dataTransfer });
    const stoppedScrollTop = list.scrollTop;
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    await expect(list.scrollTop).toBe(stoppedScrollTop);
  },
};

export const RemoteSelected: Story = {
  args: {
    servers: STORY_SERVERS.map((server) => ({ ...server, active: server.kind === "remote" })),
  },
  play: async ({ canvas }) => {
    const local = canvas.getByRole("button", { name: "Local server" });
    const remote = canvas.getByRole("button", { name: "OpenBot team server" });
    const localMarker = local.querySelector<HTMLElement>(".server-rail-mark");
    const remoteMarker = remote.querySelector<HTMLElement>(".server-rail-mark");
    if (!localMarker || !remoteMarker) throw new Error("A server marker is missing");

    await expect(getComputedStyle(localMarker).height).toBe("0px");
    await expect(getComputedStyle(remoteMarker).height).toBe("26px");
    await expect(canvas.queryByRole("button", { name: /Remote Mac|Show screen/i })).not.toBeInTheDocument();
  },
};
