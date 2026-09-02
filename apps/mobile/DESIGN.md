# OpenBot Mobile Design Guidelines

These rules apply to design, implementation, review, and AI-generated mobile UI. They define which layer owns each part of the interface and prevent the app from drifting into multiple visual systems.

## Core rule

HeroUI Native is the foundation for application content. It is already installed, its provider is mounted in `src/app/_layout.tsx`, and its theme aliases are mapped to OpenBot tokens in `global.css`.

Use HeroUI Native for product UI such as buttons, cards, fields, alerts, chips, accordions, and other content rendered inside a screen. Reuse an existing OpenBot component first, then a HeroUI Native component. Do not recreate a component that either layer already provides.

HeroUI Native is a component source, not a requirement to decorate every screen. Start with the lightest useful composition. A focused screen may need only layout, `Typography`, and one `Button`; add `Card`, `Chip`, `Surface`, or `Alert` only when it expresses real grouping, state, interaction, or actionable information.

Render product text through HeroUI Native `Typography`, including `Typography.Heading` and `Typography.Paragraph` for semantic roles. Screens and product components must not import React Native `Text` directly unless a third-party integration boundary requires the native primitive and the exception is documented.

Native system chrome is the intentional exception. Navigation and operating-system-owned controls must remain native even when HeroUI can produce a visually similar element. This lets iOS apply Liquid Glass automatically on supported versions and lets Android retain its native Material behavior.

## Component ownership

| Interface need | Preferred owner | Guidance |
| --- | --- | --- |
| Product content and reusable product controls | HeroUI Native | Use installed HeroUI components and variants. Compose them before creating a new primitive. |
| Product headings, paragraphs, labels, and inline text | HeroUI Native `Typography` | Use semantic type, color, weight, and alignment props instead of React Native `Text` and screen-local font styling. |
| Screen stacks, titles, back buttons, headers, and route transitions | Expo Router native `Stack` | Configure them in route layouts or screen options instead of drawing custom headers. |
| Tab navigation | Expo Router `NativeTabs` | Use native tab triggers, labels, badges, and platform icons instead of a custom tab bar. |
| Search integrated with navigation | `Stack.SearchBar` and native toolbar search slots | Do not place a HeroUI input inside a handmade navigation bar. |
| Header and bottom toolbar actions or menus | `Stack.Toolbar` native items | Let the platform render placement, materials, menus, and interaction behavior. |
| Route-level modals and form sheets | Expo Router native presentations | Prefer native modal or form-sheet presentation over a custom full-screen overlay. |
| Native pickers, switches, sliders, menus, and grouped system forms | `@expo/ui` | Use when the interaction should look and behave like a platform control. Keep every `@expo/ui` tree inside `Host`. |
| Large or unbounded data lists | React Native `FlatList` or an approved virtualized list | Do not use a non-virtualized component for feeds or large search results. |
| Custom in-content glass surface | `expo-glass-effect` | Use sparingly, only when glass is part of the product content rather than navigation chrome. Provide non-glass and reduced-transparency behavior. |

Native ownership takes priority over HeroUI for navigation chrome. HeroUI ownership takes priority for application content.

## Liquid Glass and platform behavior

- Obtain Liquid Glass through native navigation components. Do not imitate it with blur views, gradients, translucent HeroUI cards, shadows, or screenshots of glass.
- Do not replace native headers, tab bars, toolbars, or search bars with `GlassView`. `expo-glass-effect` is for deliberate custom content surfaces, not for rebuilding system chrome.
- Preserve automatic safe-area and scroll-edge behavior. Screens under native chrome should normally use scroll containers with automatic content inset adjustment instead of manual top or bottom spacers.
- Avoid forcing opaque colors or bespoke backgrounds onto native chrome unless the product requirement explicitly calls for it. Let the operating system adapt materials to the platform version, appearance, accessibility settings, and scroll state.
- Treat older iOS versions and Android as first-class fallbacks. The interface must remain complete and readable when Liquid Glass is unavailable or reduced transparency is enabled.
- Use platform-native icons in native navigation (`sf` on iOS and the corresponding Material icon on Android). Use the existing application icon convention for HeroUI content.

## Theme and visual consistency

- `global.css` is the single source of truth for OpenBot mobile color, typography, radius, shadow, and motion tokens. HeroUI semantic aliases consume those tokens.
- Use HeroUI semantic variants and existing utility classes. Do not add raw colors, arbitrary radii, or one-off shadows to a screen when a token or component variant can express the intent.
- Extend OpenBot tokens only for a new semantic role that will be reused. Keep HeroUI aliases mapped to OpenBot tokens rather than creating a second palette.
- Support light and dark appearance, dynamic type, reduced motion, reduced transparency, and sufficient contrast.
- Favor composition and shared variants over copying styled JSX between screens.
- Keep status and instructional copy evidence-based. Do not introduce badges, alerts, or lifecycle requirements that cannot be derived from the actual session, connectivity, or persistence implementation.

## Development workflow

Before implementing a mobile UI change:

1. Search `src/components` and current screens for an existing reusable component or pattern.
2. Check HeroUI Native for the product-content component or composition.
3. If the element is navigation chrome or a platform control, check the Expo SDK version-matched Expo Router and `@expo/ui` APIs before building anything custom.
4. Extend the existing component or token layer only when the required state or semantic role is genuinely missing.
5. Verify behavior and appearance in light and dark mode. For native chrome changes, verify both iOS and Android; include an iOS version that supports Liquid Glass when available.

Any fallback away from this ownership model must be explained in the change: what the preferred layer could not do, which platforms are affected, and how the fallback preserves accessibility and theme behavior.

## AI implementation rules

AI agents must follow the same workflow and must not infer component APIs from memory. Before changing Expo Router, `@expo/ui`, or other Expo UI code, confirm the installed Expo major version and use its versioned documentation. Before using a HeroUI Native component, confirm the installed package API or project usage.

An AI-generated UI change is incomplete when it introduces a custom navigation or search surface that a native API can own, duplicates an available HeroUI component, adds a second theme, or omits platform and accessibility fallbacks.
