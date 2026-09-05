// The test-hook budget is per occurrence rather than per file, so five of the six live
// here and the alternation is a single attribute with nothing to branch on. The sixth is
// in components/ui/Button.tsx, which is the only occurrence that distinguishes this scan
// from the composite-role one beside it: that scan exempts the design system, this one has
// no exempt directory, and dropping components/ui from it reads 5 - the budget exactly -
// and goes silent. A .test.tsx hook in Bad.test.tsx must stay uncounted, or this reads 7.
export const TestHooks = () => (
  <div data-testid="hook-one">
    <span data-testid="hook-two" />
    <span data-testid="hook-three" />
    <span data-testid="hook-four" />
    <span data-testid="hook-five" />
  </div>
);
