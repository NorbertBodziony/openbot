// @vitest-environment node

// Two checks in ui-foundation-check.ts silently matched nothing for months. The CSS
// scan named styles.css and styles/ by hand, so a stylesheet anywhere else - and one
// was, in preview/ - fell outside it; the skip list caught .test.tsx and not .test.ts.
// Both were green the whole time, because a guard with no fixture prints "passed"
// whether it is working or blind. So the check now reads a tree that breaks every rule
// once, beside correct code each rule must leave alone, and this asserts the report
// line for line. It is the contract tools/biome/anti-slop/fixtures holds the GritQL
// rules to, applied to the one guard in this repository that is not a GritQL rule.

import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkUiFoundation } from "./ui-foundation-check";

const fixtureRenderer = resolve(import.meta.dirname, "../tools/ui-foundation/fixtures/renderer");
const cleanRenderer = resolve(import.meta.dirname, "../tools/ui-foundation/fixtures/renderer-clean");

function budget(label: string, actual: number): string {
  return `${label}: ${actual} (migration budget: 0; the count may only go down)`;
}

describe("ui foundation check", () => {
  it("reports every violation the fixture tree contains, and nothing its correct files do", () => {
    const { failures } = checkUiFoundation(fixtureRenderer, fixtureRenderer);

    expect([...failures].sort()).toEqual(
      [
        "components/Bad.tsx: use a components/ui control instead of a native element",
        "components/Bad.tsx: Kobalte/Lucide imports are allowed only in components/ui",
        "components/Bad.tsx: a hand-rolled switch is forbidden; use components/ui/Switch",
        "components/Bad.tsx: a colour literal in an inline style is forbidden; use a palette token",
        "components/Bad.tsx: font-size, radius and transition in an inline style must use tokens",
        // The same check, reached through the other package it names. Kobalte firing says
        // nothing about this branch of the pattern.
        "components/Icons.tsx: Kobalte/Lucide imports are allowed only in components/ui",
        "components/ui/complex.tsx: a Kobalte namespace must go through an adapter, not a direct alias",
        // A sibling directory whose name starts with "ui". Skipping the design system is a
        // path-prefix comparison, so without a separator this line and the second composite
        // role below both disappear, and a components/ui-kit could hold anything.
        "components/ui-kit/Sneaky.tsx: use a components/ui control instead of a native element",
        // components/branches holds one file per alternative of a pattern, because these checks
        // report once per file: two alternatives in one file collapse into one finding and the
        // second stops being observable. Delete a word from an alternation and one line here goes.
        "components/branches/NativeInput.tsx: use a components/ui control instead of a native element",
        "components/branches/NativeSelect.tsx: use a components/ui control instead of a native element",
        "components/branches/NativeTextarea.tsx: use a components/ui control instead of a native element",
        "components/branches/ColourBackgroundRgb.tsx: a colour literal in an inline style is forbidden; use a palette token",
        "components/branches/ColourBackgroundRgba.tsx: a colour literal in an inline style is forbidden; use a palette token",
        "components/branches/ColourTextHsla.tsx: a colour literal in an inline style is forbidden; use a palette token",
        "components/branches/ColourBorderTopHsl.tsx: a colour literal in an inline style is forbidden; use a palette token",
        "components/branches/ColourFillNamed.tsx: a colour literal in an inline style is forbidden; use a palette token",
        "components/branches/ColourStrokeHex.tsx: a colour literal in an inline style is forbidden; use a palette token",
        "components/branches/InlineFontSize.tsx: font-size, radius and transition in an inline style must use tokens",
        "components/branches/InlineTransition.tsx: font-size, radius and transition in an inline style must use tokens",
        "components/branches/InlineTransitionDuration.tsx: font-size, radius and transition in an inline style must use tokens",
        budget("hand-rolled composite ARIA roles", 9),
        // A hex, a named colour and an hsl() in styles/legacy.css, an rgb() in preview/preview.css -
        // one per value form the pattern names.
        // A hex and a named colour in styles/legacy.css, an rgb() in preview/preview.css.
        // The rgb() is in the file the old hand-written scope missed, so a scope narrowed
        // back to a list of directory names reads 2; the named colour is matched by a
        // second pattern entirely, which the hex does not exercise, so losing that reads 2
        // as well. The token spelling a colour in tokens.css must stay uncounted, or this
        // reads 4 and the word boundaries have gone.
        budget("colour literals outside the palette", 6),
        budget("untokenized font-size", 1),
        budget("untokenized border-radius", 1),
        budget("untokenized transition durations", 2),
      ].sort(),
    );
  });

  it("counts a composite role once, ignoring the copies in test files and components/ui", () => {
    // Nine: one per role the pattern names, plus the two extra places the walk has to reach.
    // dialog appears in components/Composite.tsx and menu in features/inbox/InboxPane.tsx,
    // which is outside components/ altogether and is what keeps the walk renderer-wide;
    // ui-kit/Sneaky.tsx is the sibling directory; branches/CompositeRoles.tsx carries the
    // remaining six roles, one occurrence each, since this count is per occurrence rather
    // than per file. Bad.test.tsx and components/ui/Button.tsx each hold a role="dialog" the
    // ratchet must not see; either exclusion breaking raises this to 10, both to 11.
    const { manualCompositeCount } = checkUiFoundation(fixtureRenderer, fixtureRenderer);

    expect(manualCompositeCount).toBe(9);
  });

  it("reports nothing for a renderer that breaks no check", () => {
    // The other tree proves each check fires. This one carries the negative half for the
    // checks that report once per file, which that tree cannot: there the direct alias in
    // complex.tsx accounts for the failure whether or not a widened pattern has also
    // started rejecting the correct adapter beside it.
    const { failures, manualCompositeCount } = checkUiFoundation(cleanRenderer, cleanRenderer);

    expect(failures).toEqual([]);
    expect(manualCompositeCount).toBe(0);
  });

  it("labels a failure with a path relative to the root it is given", () => {
    // The CLI passes the repository root so a message can be pasted into an editor; the
    // walked root and the label root are not the same argument.
    const { failures } = checkUiFoundation(fixtureRenderer, resolve(fixtureRenderer, ".."));

    expect(failures).toContain(
      "renderer/components/Bad.tsx: a hand-rolled switch is forbidden; use components/ui/Switch",
    );
    // The namespace check builds its own path rather than walking to one, so it is the line
    // that stayed hard-coded while every other message moved with the root it is given.
    expect(failures).toContain(
      "renderer/components/ui/complex.tsx: a Kobalte namespace must go through an adapter, not a direct alias",
    );
  });
});
