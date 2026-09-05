// border-top, not border-color: the `color` alternative matches the substring inside
// `border-color`, so that spelling stays flagged even with the whole border branch
// deleted. This one also needs the quote the pattern now tolerates, and the hsl value.
export const ColourBorderTopHsl = () => <div style={{ "border-top": "hsl(0 100% 50%)" }} />;
