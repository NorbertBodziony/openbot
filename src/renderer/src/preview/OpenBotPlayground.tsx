import type { JSX } from "@solidjs/web";
import { onCleanup, onSettled } from "solid-js";
import { App } from "../App";
import { LANDING_PREVIEW_READY_MESSAGE, LANDING_PREVIEW_START_MESSAGE } from "./landing-demo-messages";
import { LANDING_PREVIEW_OPTIONS } from "./landing-fixtures";
import { createMockOpenBot, type MockOpenBotControls, type MockOpenBotOptions } from "./mock-openbot";

const LANDING_PREVIEW_READY_RETRY_MS = 250;

export interface OpenBotPlaygroundDependencies {
  createMock: (options?: MockOpenBotOptions) => MockOpenBotControls;
  loadLandingController?: () => Promise<typeof import("./landing-demo")>;
  renderApp: () => JSX.Element;
}

export interface OpenBotPlaygroundProps {
  dependencies?: OpenBotPlaygroundDependencies;
  options?: MockOpenBotOptions;
  variant?: "default" | "landing";
}

export function OpenBotPlayground(props: OpenBotPlaygroundProps) {
  const landingPreview = props.variant === "landing";
  const dependencies = props.dependencies ?? {
    createMock: createMockOpenBot,
    renderApp: () => <App landingPreview={landingPreview} />,
  };
  const previousApi = window.openbot;
  const mock = dependencies.createMock(landingPreview ? LANDING_PREVIEW_OPTIONS : props.options);
  window.openbot = mock.api;
  let landingController: { activate: () => void; dispose: () => void } | null = null;
  let controllerLoading: Promise<void> | null = null;
  let disposed = false;

  function activateLandingController(): void {
    if (!landingPreview || disposed) return;
    if (controllerLoading) return;
    controllerLoading = (dependencies.loadLandingController?.() ?? import("./landing-demo")).then((module) => {
      if (disposed) return;
      landingController = module.createLandingDemoController(mock, {
        reducedMotion: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
      });
      landingController.activate();
    });
    void controllerLoading;
  }

  onSettled(() => {
    if (!landingPreview || window.parent === window) return;
    const parent = window.parent;
    const origin = window.location.origin;
    let firstPaintFrame: number | undefined;
    let stablePaintFrame: number | undefined;
    let readyTimer: ReturnType<typeof setInterval> | undefined;
    let started = false;
    const reportReady = () => {
      parent.postMessage({ type: LANDING_PREVIEW_READY_MESSAGE }, origin);
    };
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== parent) return;
      if (event.data?.type !== LANDING_PREVIEW_START_MESSAGE) return;
      if (started) return;
      started = true;
      if (readyTimer) clearInterval(readyTimer);
      activateLandingController();
    };
    window.addEventListener("message", handleMessage);
    firstPaintFrame = window.requestAnimationFrame(() => {
      stablePaintFrame = window.requestAnimationFrame(() => {
        reportReady();
        readyTimer = setInterval(reportReady, LANDING_PREVIEW_READY_RETRY_MS);
      });
    });
    return () => {
      if (firstPaintFrame !== undefined) window.cancelAnimationFrame(firstPaintFrame);
      if (stablePaintFrame !== undefined) window.cancelAnimationFrame(stablePaintFrame);
      if (readyTimer) clearInterval(readyTimer);
      window.removeEventListener("message", handleMessage);
    };
  });

  onCleanup(() => {
    disposed = true;
    landingController?.dispose();
    mock.dispose();
    window.openbot = previousApi;
  });

  return dependencies.renderApp();
}
