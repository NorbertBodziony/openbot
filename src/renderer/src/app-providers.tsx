import type { JSX } from "@solidjs/web";
import type { ParentProps } from "solid-js";
import { AgentActionsProvider } from "./agent-actions";
import { AgentEventBridge } from "./agent-event-bridge";
import { AgentsProvider } from "./agents";
import { AppBootstrap } from "./app-bootstrap";
import { AuthProvider } from "./auth";
import { BrowserTabsProvider } from "./browser-tabs";
import { ConversationProvider } from "./conversation";
import { DirectMessagesProvider } from "./direct-messages";
import { DynamicIslandProvider } from "./dynamic-island";
import { DynamicIslandBridge } from "./dynamic-island-bridge";
import { LayoutProvider } from "./layout";
import { NavigationProvider } from "./navigation";
import { PlatformProvider } from "./platform";
import { PresenceProvider } from "./presence";
import { ProvidersProvider } from "./providers";
import { RemoteDesktopProvider } from "./remote-desktop";
import { ServerSelectionProvider } from "./server-selection";
import { ServerSettingsProvider } from "./server-settings";
import { ServersProvider } from "./servers";
import { SettingsProvider } from "./settings";
import { SetupProvider } from "./setup";
import { SidebarProvider } from "./sidebar";
import { TurnsProvider } from "./turns";
import { UpdatesProvider } from "./updates";

/**
 * How the renderer is mounted, as opposed to anything it later loads. Both
 * flags are fixed for the life of a mount: `index.tsx` passes neither, and
 * `preview/OpenBotPlayground.tsx` passes `landingPreview`.
 */
export interface AppProps {
  landingPreview?: boolean;
  peopleEnabled?: boolean;
}

/**
 * The composition root for renderer state: one nesting of domain providers,
 * outermost first, that every consumer below reads through its own `use*()`.
 *
 * It renders only its children today and gains one provider per migration step,
 * so the order of this file *is* the dependency graph - a domain may read one it
 * is nested inside and never one nested under it. Two rules keep it usable:
 *
 * - **It must never import `AppView.tsx`, and no gate may depend on the view
 *   tree.** The harnesses in `App.test.tsx` and `App.read-state.test.tsx` mount
 *   this with no view at all, which is why the largest test file asserts data
 *   instead of DOM. A gate waiting on something rendered would hang them both.
 * - **Nothing that runs inside it may import `App.tsx` as a value.** `App.tsx`
 *   imports this module, so a value edge back is a cycle, and `noImportCycles`
 *   is an error. The controller is therefore created by a child component in
 *   `App.tsx` rather than here, which is also what lets it read the domains
 *   already extracted.
 *
 * **No provider here is gated yet, and that is a consequence of the migration
 * order rather than a judgement about any one domain.** The only child of this
 * nesting is the whole application, so a `ready` predicate withholds not just
 * the domain's consumers but the loading screen `AppAccessGate` renders and the
 * bootstrap loads that run in parallel with the gated one - trading a startup
 * that fans out for one that runs in series, and a placeholder for a blank
 * window. Gates become available once the view is split along these same
 * boundaries and each one can sit above the domain it waits on. Until then the
 * loaded-state checks stay where they already are, in the view.
 */
export function AppProviders(props: ParentProps<AppProps>): JSX.Element {
  return (
    <PlatformProvider landingPreview={props.landingPreview} peopleEnabled={props.peopleEnabled}>
      <AuthProvider>
        <SetupProvider>
          <SettingsProvider>
            <LayoutProvider>
              <UpdatesProvider>
                <ServersProvider>
                  <DynamicIslandProvider>
                    <ServerSettingsProvider>
                      <RemoteDesktopProvider>
                        <PresenceProvider>
                          <DirectMessagesProvider>
                            <AgentsProvider>
                              <ProvidersProvider>
                                <TurnsProvider>
                                  <ConversationProvider>
                                    <BrowserTabsProvider>
                                      <SidebarProvider>
                                        <NavigationProvider>
                                          <ServerSelectionProvider>
                                            <AgentActionsProvider>
                                              <AgentEventBridge />
                                              <DynamicIslandBridge />
                                              <AppBootstrap />
                                              {props.children}
                                            </AgentActionsProvider>
                                          </ServerSelectionProvider>
                                        </NavigationProvider>
                                      </SidebarProvider>
                                    </BrowserTabsProvider>
                                  </ConversationProvider>
                                </TurnsProvider>
                              </ProvidersProvider>
                            </AgentsProvider>
                          </DirectMessagesProvider>
                        </PresenceProvider>
                      </RemoteDesktopProvider>
                    </ServerSettingsProvider>
                  </DynamicIslandProvider>
                </ServersProvider>
              </UpdatesProvider>
            </LayoutProvider>
          </SettingsProvider>
        </SetupProvider>
      </AuthProvider>
    </PlatformProvider>
  );
}
