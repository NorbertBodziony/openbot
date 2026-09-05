// The `INPUT_LIMITS`-aware predicates every IPC domain module needs.
//
// These are deliberately not in `runtime-values.ts`: that file is limit-free and is imported by the
// renderer, the backend and the preload alike, while these know the contract's own bounds. They are
// also deliberately not in the `./ipc` barrel - nothing outside this package validates a field
// without also naming the type it belongs to, and the guard that names it lives here.

import { INPUT_LIMITS } from "./input-limits";
import { isNumber, isString } from "./runtime-values";

export function isBoundedString(value: unknown, maximum: number): value is string {
  return isString(value) && value.length <= maximum;
}

export function isNullableBoundedString(value: unknown, maximum: number): value is string | null {
  return value === null || isBoundedString(value, maximum);
}

export function isIdentifier(value: unknown): value is string {
  return isBoundedString(value, INPUT_LIMITS.identifier) && value.length > 0;
}

export function isRequestId(value: unknown): value is string | number {
  return isNumber(value) || isIdentifier(value);
}

// `isNumber` alone certifies NaN and the infinities, which reach AccountDock as "NaN% remaining".
// The released Team v1 validator already rejects them for this very payload, so accepting them here
// would be the shared guard drifting from the wire one it is supposed to agree with.
export function isFiniteNumber(value: unknown): value is number {
  return isNumber(value) && Number.isFinite(value);
}

export function integerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return isNumber(value) && Number.isInteger(value) && value >= minimum && value <= maximum;
}
