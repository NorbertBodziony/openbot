# Repository guidance

## UI verification

- For renderer UI work, use only one of the supported visual verification paths: the dev app or Storybook. Do not use ad-hoc preview or rendering paths.
- Use the dev app for integrated application behavior and Storybook for isolated component visual checks.

## UI code reuse

- When you build or change a UI component, first search the codebase for existing components, hooks, styles, and utilities that you can reuse.
- Prefer reuse, composition, or a small extension of existing UI code over duplicate implementation.
- Create new UI code only when the existing code does not meet the requirement or reuse would make the code less clear or harder to maintain.

## UI colors

- Treat the custom properties in `src/renderer/src/styles.css` under `:root` as the single source of truth for the renderer color palette.
- Reuse the existing semantic tokens, such as `var(--openbot-bg-*)`, `var(--openbot-text-*)`, `var(--openbot-border*)`, `var(--openbot-accent*)`, `var(--openbot-success*)`, `var(--openbot-warning*)`, and `var(--openbot-danger*)`, instead of adding new color literals.
- Do not introduce ad-hoc hex, `rgb()`, `rgba()`, `hsl()`, or named colors in components or new CSS rules when an existing palette token is suitable.
- Before creating a new shade or token, search the palette and existing styles for a suitable semantic color. Prefer the closest existing role over a visually tweaked duplicate.
- If a genuinely new semantic role is needed, add one to the `:root` palette first and reference it through `var(...)` everywhere else. Keep aliases for backwards compatibility only when they are already used.
- Color variants with different opacity are palette tokens too; do not assemble one-off translucent colors inline.
- Keep colors required by third-party integrations, generated avatars, SVG assets, or platform APIs isolated to the integration boundary and do not use them as general UI colors.
