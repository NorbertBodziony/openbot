// What the Team API client will accept from a remote host. `packages/contracts/src/ipc-decoding.ts`
// supplies the primitives; this family says which shapes survive them.
//
// A `FromHost` decoder has a same-shaped `FromMain` twin in `src/preload/index.ts` and is deliberately
// not the same function: a remote team server is an untrusted sender, so these enumerate what the
// preload's twin is content to accept as a string. The suffix is there so a later reader does not
// merge them onto whichever is looser. The convention only works while both halves keep the suffix,
// because it is what lets a reader find the twin at all.
//
// The decoders sit in four sibling files by wire area — `remote-agent-decoding.ts`,
// `remote-conversation-decoding.ts`, `remote-team-decoding.ts`, `remote-device-decoding.ts` — and this
// file holds only what all four share.
//
// There is deliberately no `remote-*-decoding.test.ts`. These are pure functions over shapes `tsc`
// already checks; the two consequences worth naming (a host older than 63b55606 omitting `avatarUrl`,
// a browser preview that is not a bounded JPEG data URL) are covered where they are reached.

import { emptyDecoder } from "@openbot/contracts/ipc-decoding";

export type ResponseDecoder<T> = (value: unknown) => T;

export const decodeVoid = emptyDecoder("The remote server returned data.");
