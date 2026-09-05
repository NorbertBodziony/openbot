// rgba, not rgb: drop the alpha from `rgba?` and this stops matching, while the rgb file
// beside it still does. The alpha form is what most real stylesheets actually write, so
// losing it would take the colour budget blind on the common case.
export const ColourBackgroundRgba = () => <div style={{ background: "rgba(255, 0, 0, 0.5)" }} />;
