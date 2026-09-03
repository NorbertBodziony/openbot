import { lazy } from "solid-js";

/**
 * The views that are their own bundle chunk, wrapped once each.
 *
 * `lazy()` returns a component that owns the load state of its chunk, so
 * wrapping the same import twice makes two components that load the same module
 * independently - two `Loading` fallbacks, two `preload()` handles that do not
 * know about each other. Two of these are read from more than one place after
 * the view split (`InitialSetup` by the access gate and the overlays,
 * `DirectConversation` by the sidebar that preloads it and the pane that renders
 * it), so the wrappers live here and each chunk has exactly one.
 */
export const AccountDock = lazy(() =>
  import("./components/AccountDock").then((module) => ({ default: module.AccountDock })),
);
export const AccountLogin = lazy(() =>
  import("./components/AccountLogin").then((module) => ({ default: module.AccountLogin })),
);
export const DirectConversation = lazy(() =>
  import("./components/DirectConversation").then((module) => ({ default: module.DirectConversation })),
);
export const GlobalSearch = lazy(() =>
  import("./components/GlobalSearch").then((module) => ({ default: module.GlobalSearch })),
);
export const InitialSetup = lazy(() =>
  import("./components/InitialSetup").then((module) => ({ default: module.InitialSetup })),
);
export const JoinServerDialog = lazy(() =>
  import("./components/JoinServerDialog").then((module) => ({ default: module.JoinServerDialog })),
);
export const OnboardingFlow = lazy(() =>
  import("./components/OnboardingFlow").then((module) => ({ default: module.OnboardingFlow })),
);
export const RemoteDesktopWorkspace = lazy(() =>
  import("./components/RemoteDesktopWorkspace").then((module) => ({ default: module.RemoteDesktopWorkspace })),
);
export const ServerSettingsModal = lazy(() =>
  import("./components/ServerSettingsModal").then((module) => ({ default: module.ServerSettingsModal })),
);
export const SettingsModal = lazy(() =>
  import("./components/SettingsModal").then((module) => ({ default: module.SettingsModal })),
);
export const SkillsMarketplaceModal = lazy(() =>
  import("./components/SkillsMarketplaceModal").then((module) => ({ default: module.SkillsMarketplaceModal })),
);
