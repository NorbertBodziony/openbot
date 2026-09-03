import { createStore } from "solid-js";
import type { BotMessage, BotProfile } from "./data";

/**
 * Agent profiles and messages are handed to the view as stores, so replacing one
 * field re-renders only what read that field. The setter is kept beside the
 * store in a `WeakMap` rather than travelling with it, so consumers hold a plain
 * readable value and only `updateStored` can write.
 */

type StoredValue = BotProfile | BotMessage;
type StoredSetter = (value: StoredValue) => void;

const storeSetters = new WeakMap<object, StoredSetter>();

function isBotProfile(value: StoredValue): value is BotProfile {
  return "avatarSeed" in value;
}

export function createStoredProfile(value: BotProfile): BotProfile {
  const initial = Object.assign({}, value);
  const [store, setStore] = createStore(initial);
  storeSetters.set(store, (next) => {
    if (isBotProfile(next)) setStore(() => next);
  });
  return store;
}

export function createStoredMessage(value: BotMessage): BotMessage {
  const initial = Object.assign({}, value);
  const [store, setStore] = createStore(initial);
  storeSetters.set(store, (next) => {
    if (!isBotProfile(next)) setStore(() => next);
  });
  return store;
}

/** Replaces a stored value in place. A value this module did not create is ignored. */
export function updateStored(store: StoredValue, value: StoredValue): void {
  storeSetters.get(store)?.(value);
}
