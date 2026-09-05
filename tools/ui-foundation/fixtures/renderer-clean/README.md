# ui-foundation clean fixture

A renderer that breaks nothing. `../renderer` proves each check fires; this proves the whole set stays
silent on correct code, which the other tree cannot do for checks that report once per file — there,
the file holding the violation is the only `complex.tsx` the walk sees.

Same rules as the other tree: not compiled, not linted, read only by
`scripts/ui-foundation-check.test.ts`.
