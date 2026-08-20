import type { JSX } from "@solidjs/web";
import { onCleanup } from "solid-js";
import { App } from "../App";
import { createMockOpenBot, type MockOpenBotControls, type MockOpenBotOptions } from "./mock-openbot";

export interface OpenBotPlaygroundDependencies {
  createMock: (options?: MockOpenBotOptions) => MockOpenBotControls;
  renderApp: () => JSX.Element;
}

export interface OpenBotPlaygroundProps {
  dependencies?: OpenBotPlaygroundDependencies;
  options?: MockOpenBotOptions;
}

export function OpenBotPlayground(props: OpenBotPlaygroundProps) {
  const dependencies = props.dependencies ?? {
    createMock: createMockOpenBot,
    renderApp: () => <App />,
  };
  const previousApi = window.openbot;
  const mock = dependencies.createMock(props.options);
  window.openbot = mock.api;

  onCleanup(() => {
    mock.dispose();
    window.openbot = previousApi;
  });

  return dependencies.renderApp();
}
