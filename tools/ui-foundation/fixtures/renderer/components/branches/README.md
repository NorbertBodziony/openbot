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
