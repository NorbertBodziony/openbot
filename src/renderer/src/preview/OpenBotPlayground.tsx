import { onCleanup } from "solid-js";
import { App } from "../App";
import { createMockOpenBot, type MockOpenBotOptions } from "./mock-openbot";

export interface OpenBotPlaygroundProps {
  options?: MockOpenBotOptions;
}

export function OpenBotPlayground(props: OpenBotPlaygroundProps) {
  const previousApi = window.openbot;
  const mock = createMockOpenBot(props.options);
  window.openbot = mock.api;

  onCleanup(() => {
    mock.dispose();
    window.openbot = previousApi;
  });

  return <App />;
}
