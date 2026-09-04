// The throwing field readers both untrusted-input boundaries need.
//
// `src/preload/index.ts` decodes what the main process sends the renderer; the
// `src/main/remote-*-decoding.ts` family decodes what a remote team server sends this machine. They had a hand-written copy each of the same
// five readers, with identical logic and identical messages, and each was the kind of function whose
// second copy drifts silently.
//
// This is deliberately only the *identical* half. Several decoders share a name across the two files
// and are not the same function - `decodeAgentStatus` accepts any string phase in the preload and
// enumerates the phases in the server client - because they guard different boundaries: main is
// trusted by the renderer, a remote host is trusted by nobody. Merging those on the looser one would
// weaken the network boundary, so they stay apart and say in their names which side they guard.
//
// These throw, which is why they are not in `runtime-values.ts`: that file is pure non-throwing
// predicates, imported by the renderer, the backend and the preload alike.

import { type DynamicRecord, isBoolean, isDynamicRecord, isNumber, isString } from "./runtime-values";

export function decodeRecord(value: unknown, label: string): DynamicRecord {
  if (!isDynamicRecord(value)) throw new Error(`Invalid ${label}.`);
  return value;
}

export function requiredString(record: DynamicRecord, field: string): string {
  const value = record[field];
  if (!isString(value)) throw new Error(`Invalid ${field}.`);
  return value;
}

export function requiredNumber(record: DynamicRecord, field: string): number {
  const value = record[field];
  if (!isNumber(value)) throw new Error(`Invalid ${field}.`);
  return value;
}

export function requiredBoolean(record: DynamicRecord, field: string): boolean {
  const value = record[field];
  if (!isBoolean(value)) throw new Error(`Invalid ${field}.`);
  return value;
}

export function nullableString(record: DynamicRecord, field: string): string | null {
  const value = record[field];
  if (value === null || isString(value)) return value;
  throw new Error(`Invalid ${field}.`);
}

// A decoder is a `(value: unknown) => T` callback, so the label cannot be a parameter of the decoder
// itself without every call site wrapping it in a lambda. These build one instead, which keeps each
// boundary's own wording - the message is what tells a reader which side rejected the payload.
export function guardedDecoder<T>(guard: (value: unknown) => value is T, label: string): (value: unknown) => T {
  return (value) => {
    if (!guard(value)) throw new Error(`Invalid ${label}.`);
    return value;
  };
}

export function guardedListDecoder<T>(guard: (value: unknown) => value is T, label: string): (value: unknown) => T[] {
  return (value) => {
    if (!Array.isArray(value) || !value.every(guard)) throw new Error(`Invalid ${label}.`);
    return value;
  };
}

// A channel that answers with nothing has to reject a payload rather than ignore it: data where none
// was expected means the two sides disagree about the channel.
export function emptyDecoder(message: string): (value: unknown) => undefined {
  return (value) => {
    if (value !== undefined && value !== null) throw new Error(message);
    return undefined;
  };
}
