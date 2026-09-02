// Fixture for `no-chained-type-assertions`. Every line the rule must reject carries a trailing
// `// flag`; every other line is correct code the rule must leave alone.
// Checked by `scripts/anti-slop-rules.test.ts`; not compiled and not linted.

const parsed = payload as TeamFrame;
const frozen = payload as const;
const narrowed = (payload as DynamicRecord) as const;
const laundered = (payload as unknown) as TeamFrame; // flag
const doubled = (payload as DynamicRecord) as TeamFrame; // flag
