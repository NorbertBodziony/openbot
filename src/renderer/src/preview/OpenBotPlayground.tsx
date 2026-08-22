import type { JSX } from "@solidjs/web";
import { onCleanup, onSettled } from "solid-js";
import { App } from "../App";
import {
  createLandingDemoController,
  LANDING_PREVIEW_READY_MESSAGE,
  LANDING_PREVIEW_START_MESSAGE,
} from "./landing-demo";
import { LANDING_PREVIEW_OPTIONS } from "./landing-fixtures";
import { createMockOpenBot, type MockOpenBotControls, type MockOpenBotOptions } from "./mock-openbot";

export interface OpenBotPlaygroundDependencies {
  createMock: (options?: MockOpenBotOptions) => MockOpenBotControls;
  renderApp: () => JSX.Element;
}

export interface OpenBotPlaygroundProps {
  dependencies?: OpenBotPlaygroundDependencies;
  options?: MockOpenBotOptions;
  variant?: "default" | "landing";
}

export function OpenBotPlayground(props: OpenBotPlaygroundProps) {
  const dependencies = props.dependencies ?? {
    createMock: createMockOpenBot,
    renderApp: () => <App />,
  };
  const previousApi = window.openbot;
  const mock = dependencies.createMock(props.variant === "landing" ? LANDING_PREVIEW_OPTIONS : props.options);
  window.openbot = mock.api;
  const landingController =
    props.variant === "landing"
      ? createLandingDemoController(mock, {
          reducedMotion: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
        })
      : null;

  onSettled(() => {
    if (!landingController || window.parent === window) return;
    const parent = window.parent;
    const origin = window.location.origin;
    let firstPaintFrame: number | undefined;
    let stablePaintFrame: number | undefined;
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== parent) return;
      if (event.data?.type !== LANDING_PREVIEW_START_MESSAGE) return;
      landingController.activate();
    };
    window.addEventListener("message", handleMessage);
    firstPaintFrame = window.requestAnimationFrame(() => {
      stablePaintFrame = window.requestAnimationFrame(() => {
        parent.postMessage({ type: LANDING_PREVIEW_READY_MESSAGE }, origin);
      });
    });
    return () => {
      if (firstPaintFrame !== undefined) window.cancelAnimationFrame(firstPaintFrame);
      if (stablePaintFrame !== undefined) window.cancelAnimationFrame(stablePaintFrame);
      window.removeEventListener("message", handleMessage);
    };
  });

  onCleanup(() => {
    landingController?.dispose();
    mock.dispose();
    window.openbot = previousApi;
  });

  return dependencies.renderApp();
}
