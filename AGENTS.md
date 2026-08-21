# Repository guidance

## Renderer UI

- Verify integrated UI behavior in the dev app and isolated components in Storybook. Run visual tests only through these development paths; do not use production builds or ad-hoc previews.
- Before adding or changing UI code, search for reusable components, hooks, styles, and utilities. Prefer reuse, composition, or a small extension; add new code only when the existing code does not fit or would reduce clarity.
- Treat the `:root` properties in `src/renderer/src/styles.css` as the renderer color palette. Use the closest semantic `--openbot-*` token, including opacity variants, instead of ad-hoc color literals. Add a token there only for a new semantic role. Keep existing compatibility aliases when used, and isolate fixed integration, generated asset, SVG, or platform colors at their boundaries.
