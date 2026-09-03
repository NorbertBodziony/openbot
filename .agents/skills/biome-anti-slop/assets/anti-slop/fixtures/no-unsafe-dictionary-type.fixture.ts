// Fixture for `no-unsafe-dictionary-type`. Every line the rule must reject carries a trailing
// `// flag`; every other line is correct code the rule must leave alone.
// Checked by `scripts/anti-slop-rules.test.ts`; not compiled and not linted.

type Queue = Record<string, QueueDelivery>;
type ByIndex = Record<number, QueueDelivery>;
type Loose = Record<string, unknown>; // flag
type LooseNumber = Record<number, unknown>; // flag
type LooseSymbol = Record<symbol, unknown>; // flag
type LooseKey = Record<PropertyKey, unknown>; // flag
type Anyed = Record<string, any>; // flag
type Objected = Record<string, object>; // flag
