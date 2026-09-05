import type { ComputerUseMacSetupState, DesktopPlatform, MacPermissionId } from "@openbot/contracts/ipc";
import { createSignal, For, onCleanup, onSettled, Show } from "solid-js";
import {
  Alert,
  AlertActions,
  AlertContent,
  AlertDescription,
  AlertIcon,
  AlertTitle,
  Badge,
  Button,
  CircleCheck,
  Info,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
  Monitor,
  MousePointer2,
  RefreshCw,
  SettingsSection,
  Skeleton,
  TriangleAlert,
  toast,
} from "../../components/ui";

export interface ComputerUseMacSetupProps {
  platform: DesktopPlatform;
  variant: "settings" | "compact";
}

const PERMISSIONS: ReadonlyArray<{
  id: MacPermissionId;
  title: string;
  description: string;
  icon: typeof Monitor;
}> = [
  {
    id: "screen-recording",
    title: "Screen Recording",
    description: "Lets Computer Use see app windows.",
    icon: Monitor,
  },
  {
    id: "accessibility",
    title: "Accessibility",
    description: "Lets Computer Use click and type.",
    icon: MousePointer2,
  },
];

export function ComputerUseMacSetup(props: ComputerUseMacSetupProps) {
  const desktopApi = window.openbot;
  const [state, setState] = createSignal<ComputerUseMacSetupState | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [busyPermission, setBusyPermission] = createSignal<MacPermissionId | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  let disposed = false;

  async function loadState(): Promise<void> {
    if (props.platform !== "darwin" || loading()) return;
    setLoading(true);
    setError(null);
    try {
      const next = await desktopApi.getComputerUseMacSetupState();
      if (!disposed) setState(next);
    } catch (cause) {
      if (!disposed) setError(errorMessage(cause, "OpenBot could not check Computer Use."));
    } finally {
      if (!disposed) setLoading(false);
    }
  }

  async function openPermission(permission: MacPermissionId): Promise<void> {
    if (busyPermission() || state()?.status !== "available") return;
    setBusyPermission(permission);
    setError(null);
    try {
      const next = await desktopApi.openComputerUsePermissionSetup(permission);
      if (disposed) return;
      setState(next);
      if (next.status === "available") {
        toast.success("System Settings opened", {
          description: "Drag the Computer Use app into the list to finish setup.",
        });
      }
    } catch (cause) {
      if (!disposed) setError(errorMessage(cause, "OpenBot could not open System Settings."));
    } finally {
      if (!disposed) setBusyPermission(null);
    }
  }

  onSettled(() => void loadState());
  onCleanup(() => {
    disposed = true;
    void desktopApi.closeComputerUsePermissionSetup().catch(() => undefined);
  });

  const content = () => (
    <>
      <Show when={loading() && state() === null}>
        <ItemGroup class="computer-use-card computer-use-loading" aria-label="Checking Computer Use">
          <For each={[0, 1]}>
            {() => (
              <Item class="computer-use-row">
                <ItemMedia>
                  <Skeleton class="computer-use-skeleton-icon" />
                </ItemMedia>
                <ItemContent>
                  <Skeleton class="computer-use-skeleton-title" />
                  <Skeleton class="computer-use-skeleton-description" />
                </ItemContent>
              </Item>
            )}
          </For>
        </ItemGroup>
      </Show>

      <Show
        when={
          state()?.status === "unavailable" || state()?.status === "unsupported" || (!loading() && error() !== null)
        }
      >
        <Alert tone="warning" class="computer-use-alert" role="status">
          <AlertIcon>
            <TriangleAlert />
          </AlertIcon>
          <AlertContent>
            <AlertTitle>Computer Use isn’t available yet</AlertTitle>
            <AlertDescription>
              {state()?.message ?? error() ?? "OpenBot could not find the Computer Use helper."}
            </AlertDescription>
          </AlertContent>
          <AlertActions>
            <Button type="button" variant="outline" size="sm" loading={loading()} onClick={() => void loadState()}>
              <RefreshCw aria-hidden="true" />
              Try again
            </Button>
          </AlertActions>
        </Alert>
      </Show>

      <Show when={state()?.status === "available"}>
        <Show when={props.variant === "settings"}>
          <SettingsSection title="Computer Use helper">
            <ItemGroup class="settings-modal-card computer-use-card">
              <Item class="settings-modal-row computer-use-helper-row">
                <ItemMedia class="computer-use-helper-media">
                  <Show
                    when={state()?.helperIconDataUrl}
                    fallback={<Monitor class="computer-use-fallback-icon" aria-hidden="true" />}
                  >
                    {(source) => <img src={source()} alt="" />}
                  </Show>
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{state()?.helperName}</ItemTitle>
                  <ItemDescription>Controls apps for OpenBot.</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Badge variant="success-light">
                    <CircleCheck aria-hidden="true" />
                    Available
                  </Badge>
                </ItemActions>
              </Item>
            </ItemGroup>
          </SettingsSection>
        </Show>

        <Show
          when={props.variant === "settings"}
          fallback={<PermissionGroup actionLabel="Set up" busy={busyPermission()} onOpen={openPermission} />}
        >
          <SettingsSection title="System permissions" description="Permissions are managed by macOS.">
            <PermissionGroup actionLabel="Open settings" busy={busyPermission()} onOpen={openPermission} />
          </SettingsSection>
        </Show>
      </Show>

      <Show when={error() && state()?.status === "available"}>
        <Alert tone="danger" class="computer-use-alert" role="alert">
          <AlertIcon>
            <Info />
          </AlertIcon>
          <AlertContent>
            <AlertTitle>Couldn’t open Computer Use setup</AlertTitle>
            <AlertDescription>{error()}</AlertDescription>
          </AlertContent>
        </Alert>
      </Show>
    </>
  );

  return (
    <Show when={props.platform === "darwin"}>
      <Show
        when={props.variant === "settings"}
        fallback={
          <section class="computer-use-compact" aria-labelledby="computer-use-compact-title">
            <header class="computer-use-compact-header">
              <div>
                <h2 id="computer-use-compact-title">Enable Computer Use</h2>
                <p>Let OpenBot see and interact with apps on this Mac.</p>
              </div>
              <span>Optional</span>
            </header>
            {content()}
          </section>
        }
      >
        <div class="computer-use-settings">{content()}</div>
      </Show>
    </Show>
  );
}

function PermissionGroup(props: {
  actionLabel: string;
  busy: MacPermissionId | null;
  onOpen: (permission: MacPermissionId) => Promise<void>;
}) {
  return (
    <ItemGroup class="settings-modal-card computer-use-card computer-use-permission-list">
      <For each={PERMISSIONS}>
        {(permission) => {
          const PermissionIcon = permission.icon;
          return (
            <Item class="settings-modal-row computer-use-row">
              <ItemMedia class="computer-use-permission-icon">
                <PermissionIcon aria-hidden="true" />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{permission.title}</ItemTitle>
                <ItemDescription>{permission.description}</ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  loading={props.busy === permission.id}
                  loadingLabel="Opening…"
                  disabled={props.busy !== null}
                  onClick={() => void props.onOpen(permission.id)}
                >
                  {props.actionLabel}
                </Button>
              </ItemActions>
            </Item>
          );
        }}
      </For>
    </ItemGroup>
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
