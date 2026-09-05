// Not components/ui - a sibling whose name merely starts with it. Every check that skips
// the design system compares a path prefix, so without a separator this whole directory
// reads as being inside it and nothing here is ever reported. Holds one violation for
// each of the two places that comparison is made: the per-file walk, and the composite
// role count.
export function Sneaky() {
  return (
    <div role="dialog">
      <button type="button">Confirm</button>
    </div>
  );
}
