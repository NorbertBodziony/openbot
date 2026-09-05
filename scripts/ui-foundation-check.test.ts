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

function budget(label: string, actual: number): string {
  return `${label}: ${actual} (budżet migracyjny: 0; liczba może tylko maleć)`;
}

describe("ui foundation check", () => {
  it("reports every violation the fixture tree contains, and nothing its correct files do", () => {
    const { failures } = checkUiFoundation(fixtureRenderer, fixtureRenderer);

    expect([...failures].sort()).toEqual(
      [
        "components/Bad.tsx: użyj komponentu z components/ui zamiast natywnej kontrolki",
        "components/Bad.tsx: import Kobalte/Lucide jest dozwolony wyłącznie w components/ui",
        "components/Bad.tsx: ręczny switch jest zabroniony; użyj components/ui/Switch",
        "components/Bad.tsx: literał koloru w inline style jest zabroniony; użyj tokenu palety",
        "components/Bad.tsx: font-size, radius i transition w inline style muszą używać tokenów",
        // The same check, reached through the other package it names. Kobalte firing says
        // nothing about this branch of the pattern.
        "components/Icons.tsx: import Kobalte/Lucide jest dozwolony wyłącznie w components/ui",
        "components/ui/complex.tsx: namespace Kobalte musi przechodzić przez adapter, nie bezpośredni alias",
        budget("ręczne złożone role ARIA", 1),
        // A hex and a named colour in styles/legacy.css, an rgb() in preview/preview.css.
        // The rgb() is in the file the old hand-written scope missed, so a scope narrowed
        // back to a list of directory names reads 2; the named colour is matched by a
        // second pattern entirely, which the hex does not exercise, so losing that reads 2
        // as well. The token spelling a colour in tokens.css must stay uncounted, or this
        // reads 4 and the word boundaries have gone.
        budget("literały kolorów poza paletą", 3),
        budget("nietokenizowane font-size", 1),
        budget("nietokenizowane border-radius", 1),
        budget("nietokenizowane czasy transition", 1),
      ].sort(),
    );
  });

  it("counts a composite role once, ignoring the copies in test files and components/ui", () => {
    // Bad.test.tsx and components/ui/Button.tsx each hold a role="dialog" the ratchet must
    // not see. Either exclusion breaking raises this to 2, both to 3 - which is a clearer
    // failure than the budget line, because it says how many exclusions went.
    const { manualCompositeCount } = checkUiFoundation(fixtureRenderer, fixtureRenderer);

    expect(manualCompositeCount).toBe(1);
  });

  it("labels a failure with a path relative to the root it is given", () => {
    // The CLI passes the repository root so a message can be pasted into an editor; the
    // walked root and the label root are not the same argument.
    const { failures } = checkUiFoundation(fixtureRenderer, resolve(fixtureRenderer, ".."));

    expect(failures).toContain("renderer/components/Bad.tsx: ręczny switch jest zabroniony; użyj components/ui/Switch");
  });
});
