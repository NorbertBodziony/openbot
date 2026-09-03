// The always-on-top island window: its preference, its presentation, and the actions and
// haptics it sends back.

import { IPC_CHANNELS } from "@openbot/contracts/ipc";
import { type DynamicIslandWindowController, requireDynamicIslandSender } from "../dynamic-island-window";
import { handleTrustedWithEvent } from "../trusted-ipc";
import {
  parseDynamicIslandAction,
  parseDynamicIslandInteractive,
  parseDynamicIslandPreference,
  parseDynamicIslandPresentation,
} from "./app-inputs";

export interface DynamicIslandIpcDependencies {
  dynamicIsland: DynamicIslandWindowController;
}

export function registerDynamicIslandIpcHandlers({ dynamicIsland }: DynamicIslandIpcDependencies): void {
  handleTrustedWithEvent(IPC_CHANNELS.dynamicIslandGetPreference, (event) => {
    requireDynamicIslandSender(
      event.sender.id,
      new Set([...dynamicIsland.mainRendererIds, ...dynamicIsland.overlayRendererIds]),
      "main or Dynamic Island renderer",
    );
    return dynamicIsland.preference;
  });
  handleTrustedWithEvent(
    IPC_CHANNELS.dynamicIslandSetPreference,
    (event) => requireDynamicIslandSender(event.sender.id, dynamicIsland.mainRendererIds, "main renderer"),
    parseDynamicIslandPreference,
    (_event, preference) => dynamicIsland.setPreference(preference),
  );
  handleTrustedWithEvent(
    IPC_CHANNELS.dynamicIslandPublishPresentation,
    (event) => requireDynamicIslandSender(event.sender.id, dynamicIsland.mainRendererIds, "main renderer"),
    parseDynamicIslandPresentation,
    (_event, presentation) => dynamicIsland.publish(presentation),
  );
  handleTrustedWithEvent(IPC_CHANNELS.dynamicIslandGetPresentation, (event) => {
    requireDynamicIslandSender(event.sender.id, dynamicIsland.overlayRendererIds, "Dynamic Island renderer");
    return dynamicIsland.presentation;
  });
  handleTrustedWithEvent(
    IPC_CHANNELS.dynamicIslandPerformAction,
    (event) => requireDynamicIslandSender(event.sender.id, dynamicIsland.overlayRendererIds, "Dynamic Island renderer"),
    parseDynamicIslandAction,
    (_event, action) => dynamicIsland.performAction(action),
  );
  handleTrustedWithEvent(IPC_CHANNELS.dynamicIslandPerformHaptic, (event) => {
    requireDynamicIslandSender(event.sender.id, dynamicIsland.overlayRendererIds, "Dynamic Island renderer");
    dynamicIsland.performHaptic();
  });
  handleTrustedWithEvent(
    IPC_CHANNELS.dynamicIslandSetInteractive,
    (event) => requireDynamicIslandSender(event.sender.id, dynamicIsland.overlayRendererIds, "Dynamic Island renderer"),
    parseDynamicIslandInteractive,
    (event, state) => dynamicIsland.setInteractive(event.sender.id, state.interactive),
  );
}
