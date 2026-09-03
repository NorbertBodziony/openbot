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
  handleTrustedWithEvent(IPC_CHANNELS.dynamicIslandSetPreference, (event, input: unknown) => {
    requireDynamicIslandSender(event.sender.id, dynamicIsland.mainRendererIds, "main renderer");
    return dynamicIsland.setPreference(parseDynamicIslandPreference(input));
  });
  handleTrustedWithEvent(IPC_CHANNELS.dynamicIslandPublishPresentation, (event, input: unknown) => {
    requireDynamicIslandSender(event.sender.id, dynamicIsland.mainRendererIds, "main renderer");
    dynamicIsland.publish(parseDynamicIslandPresentation(input));
  });
  handleTrustedWithEvent(IPC_CHANNELS.dynamicIslandGetPresentation, (event) => {
    requireDynamicIslandSender(event.sender.id, dynamicIsland.overlayRendererIds, "Dynamic Island renderer");
    return dynamicIsland.presentation;
  });
  handleTrustedWithEvent(IPC_CHANNELS.dynamicIslandPerformAction, (event, input: unknown) => {
    requireDynamicIslandSender(event.sender.id, dynamicIsland.overlayRendererIds, "Dynamic Island renderer");
    return dynamicIsland.performAction(parseDynamicIslandAction(input));
  });
  handleTrustedWithEvent(IPC_CHANNELS.dynamicIslandPerformHaptic, (event) => {
    requireDynamicIslandSender(event.sender.id, dynamicIsland.overlayRendererIds, "Dynamic Island renderer");
    dynamicIsland.performHaptic();
  });
  handleTrustedWithEvent(IPC_CHANNELS.dynamicIslandSetInteractive, (event, input: unknown) => {
    requireDynamicIslandSender(event.sender.id, dynamicIsland.overlayRendererIds, "Dynamic Island renderer");
    dynamicIsland.setInteractive(event.sender.id, parseDynamicIslandInteractive(input).interactive);
  });
}
