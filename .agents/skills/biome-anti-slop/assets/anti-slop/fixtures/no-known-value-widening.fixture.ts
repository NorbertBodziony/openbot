// Fixture for `no-known-value-widening`. Every line the rule must reject carries a trailing
// `// flag`; every other line is correct code the rule must leave alone.
// Checked by `scripts/anti-slop-rules.test.ts`; not compiled and not linted.

const summary = readDelivery();
const typed: QueueDelivery = readDelivery();
const checked = readDelivery() satisfies QueueDelivery;
const widened: unknown = readDelivery(); // flag
const anyed: any = readDelivery(); // flag
const objected: object = readDelivery(); // flag
const dictionary: Record<string, unknown> = readDelivery(); // flag
const looseDictionary: Record<string, any> = readDelivery(); // flag
