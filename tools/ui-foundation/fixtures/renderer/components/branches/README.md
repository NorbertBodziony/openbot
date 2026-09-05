# One file per rule branch

Every check above reports at most once per file, so two alternatives of the same pattern placed in
one file collapse into a single finding and the second stops being observable. Each file here holds
exactly one alternative of one pattern, and contributes exactly one line to the expected report.

The test for whether a branch needs a file is the one this whole tree exists for: delete it and see
whether the report changes. A branch no other alternative absorbs gets a file - including the
optional `(?:-duration)?` group, because after `transition` comes a hyphen rather than the colon the
pattern needs, so nothing else matches it. A branch that is absorbed does not, and cannot be given
one: `(?:-color)?` is unreachable as a test, because the bare `color` alternative matches the
substring inside `background-color` and `border-color` whatever happens to the border branch. That
is why the border case here is spelled `border-top`.

Coverage stops where the consequence does, not where the alternation does. `rgba` and `hsla` have
files because the alpha form is what most stylesheets actually write, so losing that branch would
take the colour budget blind on the common case. The `right`, `bottom` and `left` directions do not:
they are three parallel words in one group that no edit removes singly, `border-right-color` stays
caught by the bare `color` alternative either way, and an inline `border-right` set to a bare colour
is not a thing this renderer writes. A file per branch that protects nothing lengthens the expected
report until it is read the way a snapshot is - updated rather than checked.
