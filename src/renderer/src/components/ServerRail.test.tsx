import type { ServerSummary } from "@openbot/contracts/ipc";
import { fireEvent, render } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { ServerRail } from "./ServerRail";

function server(id: string, kind: "local" | "remote"): ServerSummary {
  return {
    id,
    name: id,
    logoUrl: null,
    kind,
    state: "online",
    apiUrl: null,
    remoteDesktopAvailable: false,
    role: null,
    active: kind === "local",
  };
}

describe("ServerRail", () => {
  it("keeps the drag preview inside the rail and locks its horizontal position", () => {
    const view = render(() => (
      <ServerRail
        servers={[server("local", "local"), server("remote-1", "remote"), server("remote-2", "remote")]}
        onSelect={vi.fn()}
        onReorder={vi.fn()}
        onAdd={vi.fn()}
        onOpenSettings={vi.fn()}
      />
    ));
    const list = view.container.querySelector<HTMLDivElement>(".server-rail-list");
    const item = view.container.querySelector<HTMLLIElement>(".server-rail-server-item");
    if (!list || !item) throw new Error("Server rail elements are missing.");

    vi.spyOn(list, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ x: 0, y: 10, width: 72, height: 390 }));
    vi.spyOn(item, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ x: 8, y: 60, width: 56, height: 46 }));
    const dataTransfer = {
      setData: vi.fn(),
      setDragImage: vi.fn(),
      effectAllowed: "move",
      dropEffect: "move",
    };
    const dragStart = new MouseEvent("dragstart", {
      bubbles: true,
      cancelable: true,
      clientX: 24,
      clientY: 70,
    });
    Object.defineProperty(dragStart, "dataTransfer", { value: dataTransfer });
    fireEvent(item, dragStart);

    const preview = document.body.querySelector<HTMLElement>(".server-rail-drag-preview");
    expect(preview).toBeInTheDocument();
    expect(dataTransfer.setDragImage).toHaveBeenCalled();
    expect(preview).toHaveStyle({ left: "8px", top: "60px", width: "56px" });

    window.dispatchEvent(new MouseEvent("dragover", { clientX: 900, clientY: 500 }));
    expect(preview).toHaveStyle({ left: "8px", top: "354px" });

    window.dispatchEvent(new MouseEvent("dragover", { clientX: -500, clientY: 0 }));
    expect(preview).toHaveStyle({ left: "8px", top: "10px" });

    fireEvent.dragEnd(item, { dataTransfer });
    expect(preview).not.toBeInTheDocument();
  });
});
