import { PlatformLogo } from "@openbot/brand";
import { createSignal, createUniqueId, For, onSettled, Show } from "solid-js";
import {
  DOWNLOAD_PLATFORM_ORDER,
  DOWNLOAD_PLATFORMS,
  type DownloadPlatform,
  detectDownloadPlatform,
} from "../../lib/download-platforms";
import { EXTERNAL_LINK_REL } from "../../lib/landing-links";
import { LandingIcon } from "./LandingIcon";

export function HeroDownloadSelector() {
  const menuId = createUniqueId();
  const [platform, setPlatform] = createSignal<DownloadPlatform>("macos");
  const [open, setOpen] = createSignal(false);
  let root: HTMLDivElement | undefined;
  let trigger: HTMLButtonElement | undefined;

  const current = () => DOWNLOAD_PLATFORMS[platform()];
  const menuItems = () => Array.from(root?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);

  function closeMenu(restoreFocus = false): void {
    setOpen(false);
    if (restoreFocus) trigger?.focus();
  }

  function openMenu(focus: "first" | "last" | false = false): void {
    setOpen(true);
    if (!focus) return;
    queueMicrotask(() => {
      const items = menuItems();
      (focus === "first" ? items[0] : items.at(-1))?.focus();
    });
  }

  function selectPlatform(nextPlatform: DownloadPlatform): void {
    setPlatform(nextPlatform);
    closeMenu(true);
  }

  function handleKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape" && open()) {
      event.preventDefault();
      closeMenu(true);
      return;
    }

    if (event.target === trigger && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      openMenu(event.key === "ArrowDown" ? "first" : "last");
      return;
    }

    if (!open() || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = menuItems();
    const activeElement = document.activeElement;
    const activeIndex = activeElement instanceof HTMLElement ? items.indexOf(activeElement) : -1;
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (activeIndex + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    event.preventDefault();
    items[nextIndex]?.focus();
  }

  onSettled(() => {
    const detected = detectDownloadPlatform(globalThis.navigator);
    if (detected) setPlatform(detected);

    const handleOutsidePointer = (event: PointerEvent) => {
      if (open() && event.target instanceof Node && !root?.contains(event.target)) closeMenu();
    };
    document.addEventListener("pointerdown", handleOutsidePointer);
    return () => document.removeEventListener("pointerdown", handleOutsidePointer);
  });

  return (
    <div
      ref={root}
      class="landing-download-selector"
      data-detected-platform={platform()}
      data-open={open() ? "true" : "false"}
    >
      <div class="landing-download-split">
        <Show
          when={current().available && current().href}
          fallback={
            <span class="landing-download-primary" data-state="coming-soon" aria-disabled="true">
              <PlatformLogo platform={platform()} />
              {current().action}
            </span>
          }
        >
          {(href) => (
            <a
              class="landing-download-primary"
              href={href()}
              target="_blank"
              rel={EXTERNAL_LINK_REL}
              data-state="available"
            >
              <PlatformLogo platform={platform()} />
              {current().action}
            </a>
          )}
        </Show>
        <button
          ref={trigger}
          class="landing-download-trigger"
          type="button"
          aria-label="Choose download platform"
          aria-haspopup="menu"
          aria-expanded={open() ? "true" : "false"}
          aria-controls={menuId}
          onClick={() => (open() ? closeMenu() : openMenu())}
          onKeyDown={handleKeyDown}
        >
          <LandingIcon name="chevron-down" />
        </button>
      </div>

      <Show when={open()}>
        <div
          id={menuId}
          class="landing-download-menu"
          role="menu"
          aria-label="Download platforms"
          onKeyDown={handleKeyDown}
        >
          <For each={DOWNLOAD_PLATFORM_ORDER}>
            {(menuPlatform) => {
              const details = DOWNLOAD_PLATFORMS[menuPlatform];
              return (
                <Show
                  when={details.available && details.href}
                  fallback={
                    <button
                      class="landing-download-menu-item"
                      type="button"
                      role="menuitem"
                      data-state="coming-soon"
                      data-selected={platform() === menuPlatform ? "true" : undefined}
                      onClick={() => selectPlatform(menuPlatform)}
                    >
                      <PlatformLogo platform={menuPlatform} />
                      <span>{details.label}</span>
                      <small>{details.status}</small>
                    </button>
                  }
                >
                  {(href) => (
                    <a
                      class="landing-download-menu-item"
                      href={href()}
                      target="_blank"
                      rel={EXTERNAL_LINK_REL}
                      role="menuitem"
                      data-state="available"
                      data-selected={platform() === menuPlatform ? "true" : undefined}
                      onClick={() => selectPlatform(menuPlatform)}
                    >
                      <PlatformLogo platform={menuPlatform} />
                      <span>{details.label}</span>
                      <small>{details.status}</small>
                    </a>
                  )}
                </Show>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
}
