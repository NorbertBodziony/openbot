# One file per rule branch

Every check above reports at most once per file, so two alternatives of the same pattern placed in
one file collapse into a single finding and the second stops being observable. Each file here holds
exactly one alternative of one pattern, and contributes exactly one line to the expected report.
Delete that alternative from the pattern and this file's line disappears.

Optional suffix groups - `(?:-color)?`, `(?:-duration)?`, `(?:-(?:top|right|bottom|left))?` - are
refinements of an alternative already covered here, not alternatives of their own, and are not given
a file each.
