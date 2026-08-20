import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HeroDownloadSelector } from "../src/components/landing/HeroDownloadSelector";
import { OPENBOT_DOWNLOAD_LINKS } from "../src/lib/landing-links";

function setPlatform(platform: string): void {
  vi.stubGlobal("navigator", { platform, userAgent: "" });
}

const AVAILABLE_PLATFORM_CASES: ReadonlyArray<
  readonly [source: string, platform: keyof typeof OPENBOT_DOWNLOAD_LINKS, label: string]
> = [
  ["MacIntel", "macos", "Download for macOS"],
  ["Win32", "windows", "Download for Windows"],
];

describe("HeroDownloadSelector", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(AVAILABLE_PLATFORM_CASES)(
    "detects %s and renders the available download",
    async (source, expected, label) => {
      setPlatform(source);
      const view = render(() => <HeroDownloadSelector />);
      const selector = view.container.querySelector(".landing-download-selector");

      await waitFor(() => expect(selector).toHaveAttribute("data-detected-platform", expected));
      const download = view.getByRole("link", { name: label });
      expect(download).toHaveAttribute("href", OPENBOT_DOWNLOAD_LINKS[expected]);
      expect(download).not.toHaveAttribute("target");
      expect(download).not.toHaveAttribute("rel");
    },
  );

  it("shows all platforms and keeps Linux as coming soon", async () => {
    setPlatform("MacIntel");
    const view = render(() => <HeroDownloadSelector />);
    const trigger = view.getByRole("button", { name: "Choose download platform" });

    await fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(view.getByRole("menu", { name: "Download platforms" })).toBeInTheDocument();
    expect(view.getAllByRole("menuitem")).toHaveLength(3);

    await fireEvent.click(view.getByRole("menuitem", { name: /Linux.*Coming soon/i }));
    await waitFor(() =>
      expect(view.container.querySelector(".landing-download-selector")).toHaveAttribute(
        "data-detected-platform",
        "linux",
      ),
    );
    expect(view.queryByRole("menu")).not.toBeInTheDocument();
    expect(view.getByText("Linux coming soon")).toHaveAttribute("aria-disabled", "true");
    expect(view.queryByRole("link", { name: "Linux coming soon" })).not.toBeInTheDocument();
  });

  it("supports arrow keys, Escape and outside clicks", async () => {
    setPlatform("Win32");
    const view = render(() => <HeroDownloadSelector />);
    const trigger = view.getByRole("button", { name: "Choose download platform" });

    await fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toHaveAttribute("role", "menuitem"));
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement)) throw new Error("Expected a focused menu item");
    await fireEvent.keyDown(activeElement, { key: "Escape" });
    expect(view.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    await fireEvent.click(trigger);
    await fireEvent.pointerDown(document.body);
    expect(view.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("shows the Linux state immediately after Linux detection", async () => {
    setPlatform("Linux x86_64");
    const view = render(() => <HeroDownloadSelector />);

    await waitFor(() => expect(view.getByText("Linux coming soon")).toBeInTheDocument());
    expect(view.queryByRole("link", { name: "Linux coming soon" })).not.toBeInTheDocument();
  });
});
