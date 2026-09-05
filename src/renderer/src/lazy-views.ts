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
  import("./features/account/AccountDock").then((module) => ({ default: module.AccountDock })),
);
export const AccountLogin = lazy(() =>
  import("./features/account/AccountLogin").then((module) => ({ default: module.AccountLogin })),
);
export const DirectConversation = lazy(() =>
  import("./features/conversation/DirectConversation").then((module) => ({ default: module.DirectConversation })),
);
export const GlobalSearch = lazy(() =>
  import("./components/GlobalSearch").then((module) => ({ default: module.GlobalSearch })),
);
export const InitialSetup = lazy(() =>
  import("./features/onboarding/InitialSetup").then((module) => ({ default: module.InitialSetup })),
);
export const JoinServerDialog = lazy(() =>
  import("./features/servers/JoinServerDialog").then((module) => ({ default: module.JoinServerDialog })),
);
export const OnboardingFlow = lazy(() =>
  import("./features/onboarding/OnboardingFlow").then((module) => ({ default: module.OnboardingFlow })),
);
export const RemoteDesktopWorkspace = lazy(() =>
  import("./features/remote-desktop/RemoteDesktopWorkspace").then((module) => ({
    default: module.RemoteDesktopWorkspace,
  })),
);
export const ServerSettingsModal = lazy(() =>
  import("./features/servers/ServerSettingsModal").then((module) => ({ default: module.ServerSettingsModal })),
);
export const SettingsModal = lazy(() =>
  import("./features/settings/SettingsModal").then((module) => ({ default: module.SettingsModal })),
);
export const SkillsMarketplaceModal = lazy(() =>
  import("./features/settings/SkillsMarketplaceModal").then((module) => ({ default: module.SkillsMarketplaceModal })),
);
