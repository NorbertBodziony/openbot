// Fixture for `no-shape-in-symbol-names`. Every line the rule must reject carries a trailing
// `// flag`; every other line is correct code the rule must leave alone.
// Checked by `scripts/anti-slop-rules.test.ts`; not compiled and not linted.

const deliveryRow = readDelivery();
type QueueDelivery = { readonly id: string };
const messageShape = readDelivery(); // flag
type FrameShape = { readonly id: string }; // flag
function buildShape(id: string) { // flag
  return { id };
}
