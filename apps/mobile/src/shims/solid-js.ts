// Bloub currently publishes its DOM-free engine in the same bundle as its Solid component.
// Mobile imports only BotEngine and its data; these exports keep the unused UI layer out of Metro.
function unsupportedSolidUi(): never {
  throw new Error("The Solid UI layer from bloub is not available in the native app.");
}

export const For = unsupportedSolidUi;
export const Show = unsupportedSolidUi;
export const createEffect = unsupportedSolidUi;
export const createMemo = unsupportedSolidUi;
export const createSignal = unsupportedSolidUi;
export const createUniqueId = unsupportedSolidUi;
export const onCleanup = unsupportedSolidUi;
export const onSettled = unsupportedSolidUi;
export const untrack = unsupportedSolidUi;
