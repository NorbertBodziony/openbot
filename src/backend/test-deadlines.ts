// One source of truth for the two deadlines that used to be equal by accident.
//
// The harness `waitFor` had a hardcoded 5000 ms deadline and vitest's default
// `testTimeout` is also 5000 ms, so under load it was a coin flip which one
// fired. Vitest winning is the bad outcome: it reports that the test ran out of
// time, not which condition never became true, and it reports it identically
// for all 158 call sites. The harness has to lose to nothing, so vitest's
// budget is derived from the harness deadline rather than written down twice.

/** How long a harness `waitFor` polls before failing with the predicate that never held. */
export const HARNESS_WAIT_TIMEOUT_MS = 10_000;

/** Vitest's per-test budget. Strictly greater, so the harness always reports first. */
export const NODE_TEST_TIMEOUT_MS = HARNESS_WAIT_TIMEOUT_MS * 2;
