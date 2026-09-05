import type { ServerSummary } from "@openbot/contracts/ipc";
import { For } from "solid-js";
import { Alert, AlertContent, AlertDescription, Button } from "../../components/ui";

/**
 * What the workspace shows instead of a conversation when the active server is
 * a remote one this build cannot talk to. It takes the server and the retry as
 * props rather than reading `useServers()`: the shell already holds the server
 * in a keyed `<Show>` so that a different blocked server remounts this screen,
 * and a context read here would quietly re-derive what that key already decided.
 */
export function RemoteCompatibilityScreen(props: { server: ServerSummary; onRetry: () => Promise<void> }) {
  const title = () => {
    if (props.server.issue?.code === "client_update_required") return "Update this OpenBot app";
    if (props.server.issue?.code === "host_update_required") return `Update OpenBot on ${props.server.name}`;
    return "The host returned unsafe data";
  };
  const description = () => {
    if (props.server.issue?.code === "client_update_required") {
      return "This app supports only older protocols than the host. Update this app, then try again.";
    }
    if (props.server.issue?.code === "host_update_required") {
      return "The host supports only older protocols than this app. Update the host, then try again.";
    }
    return "OpenBot stopped this connection because a known payload was invalid. Your current workspace data was not changed.";
  };
  const compatibility = () => props.server.compatibility;
  const details = () => [
    ["Client version", compatibility()?.localAppVersion ?? "Unknown"],
    ["Host version", compatibility()?.hostAppVersion ?? "Unknown"],
    ["Negotiated protocol", compatibility()?.negotiatedProtocol ?? "None"],
  ];

  return (
    <main class="remote-compatibility-screen" aria-labelledby="remote-compatibility-title">
      <Alert class="remote-compatibility-alert" tone="danger" role="alert">
        <AlertContent>
          <h1 class="ui-alert-title" id="remote-compatibility-title">
            {title()}
          </h1>
          <AlertDescription>{description()}</AlertDescription>
        </AlertContent>
      </Alert>
      <dl class="remote-compatibility-details">
        <For each={details()}>
          {([label, value]) => (
            <div>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          )}
        </For>
      </dl>
      <Button onClick={() => void props.onRetry()}>Retry</Button>
    </main>
  );
}
