# OpenBot Mobile

React Native app built with Expo SDK 57, Expo Router, TypeScript 7, Biome, and Bun. The app uses Expo Continuous Native Generation, so native `ios/` and `android/` directories are intentionally not committed.

## Requirements

- Node.js 24 or newer (the repository pins 24 in `.nvmrc`)
- Bun 1.3 or newer
- Expo Go for device testing, including the WebRTC server connection

## Development

Expo Router 57.0.17 is patched in `patches/expo-router@57.0.17.patch` to apply zoom dismissal
bounds when its enabler registers after the chat mounts. This keeps the avatar-to-header zoom
interactive from the left edge without enabling dismissal from the middle of the chat.
The same patch keeps navigation queue snapshots immutable so React observes every navigation
action, including the first tap when reopening a chat after going back.
If a row or pinned avatar is tapped during the native return transition, the app retains that
tap until the list is focused and `transitionEnd` fires. It then invokes the original Link
handler once, preserving its AppleZoom source without a fixed delay.
Focus is read from the route's live `isFocused()` state; nested navigators do not always emit
an initial `focus` event, so a first tap must not depend on receiving one.

Keyboard Controller 1.21.9 is included in SDK 57 Expo Go. Custom development clients and
standalone apps must be rebuilt after adding this native dependency; a JavaScript reload alone
cannot add it to an existing binary. All channels use the fingerprint runtime policy, so these
updates cannot target older app-version `1.0.0` binaries without Keyboard Controller. Build and
distribute a binary with the new fingerprint before publishing compatible OTA updates.

Run commands from the repository root:

```bash
bun run mobile
bun run mobile:ios
bun run mobile:android
```

For an Expo Go device outside the computer's trusted local network context, start Metro with a secure
tunnel:

```bash
bun run mobile -- --tunnel
```

The native UI does not depend on a native WebRTC module. A hidden Expo DOM component owns the browser
`RTCPeerConnection` and its authenticated DataChannels, then forwards validated commands and live
events to React Native. This keeps the production transport identical while remaining testable in
Expo Go without a development build.

Remote connection recovery makes up to five attempts, waiting 10 seconds after each failure. After
five failures it waits two minutes before starting a new series. The bot list shows `Reconnecting`
beside the server-list button in the header, with a smaller attempt counter and retry countdown below.
The status disappears once connected. Chat shows a compact, centered `Reconnecting · x/5 · m:ss`
above the composer, with the same animated digits and no banner. The composer and status float over
the message list on a transparent layer; bottom spacing keeps the last message clear of the controls.
The composer and status track interactive keyboard dismissal through `KeyboardStickyView`;
`KeyboardChatScrollView` uses the same native keyboard frames for message insets and scrolling.
There is no additional `KeyboardAvoidingView` or keyboard-event timer in the chat. The status disappears
after reconnecting. Countdown ticks are local UI
updates, not requests. Backgrounding suspends retries; returning respects any remaining wait and
starts at most one attempt if its deadline has passed. A successful connection resets the counter. Dead
WebRTC peers are discarded and authenticated again. Recovery reloads cached conversations as well
as agents and unread counts, including after an event-buffer reset. An interruption of Signal alone
can resume sooner while the authenticated WebRTC connection is still healthy, without a new ticket.

Chat links use a local link icon, with a smaller icon in thought-process text. Rendering links
or Markdown images does not contact their destinations; they open only on tap.

The Bloub loading overlay first renders a single idle pose. After commit, the animation provider
prepares one shared 30 fps sequence in idle batches of at most four frames. Hidden loaders and
reduced-motion mode do not start that work. Exit geometry is prepared the same way while holding
the current pose, then settles to idle before scaling down; unfinished preparation is cancelled
when no longer needed.

Structured question forms appear inline in mobile chat, including when reopening downloaded history.
They support option selection, multiple questions, skipping and cancellation. Custom answers are typed
in the main chat composer and sent to the current form question, rather than posted as chat messages. Responses
use the existing `/v1/prompts/respond` endpoint over the authenticated desktop connection; conversation
updates synchronize their resolution across devices. Offline forms are disabled, failed submissions
can be retried, and completed or expired forms cannot be submitted again. Private answers use a
secure input and are omitted from the local completion summary; unsent drafts stay in component memory.

When no bots have loaded and the selected server is connecting or offline, the bot list shows
`Waiting for connection`. The empty-server prompt appears only once the server is online; bots
already loaded remain visible during reconnection.

While a server is disconnected, its bot avatars and colored chat bubbles fade locally with the same
280 ms transition. Chat input, attachments,
voice/send controls and suggested prompts are disabled. Draft text is preserved, and the controls
and original colors return when the server is online. This visual state is derived only in the
mobile UI: it never changes the bot's synced avatar profile or sends appearance updates over RTC.

Invitations pin the desktop public key before acceptance. Pins are stored in the device Keychain /
Keystore, scoped to the account service and user, and checked on later directory refreshes. Joining
installs the validated host immediately; a subsequent directory-refresh failure does not undo a
successful join or require reusing the one-use invitation.

After Mobile Connect has enabled publishing, restarting the development desktop restores its
WebRTC host as well as its local HTTP API. A local-only `online` status is not enough for mobile
connections. The separate development test client never auto-publishes.

## Source structure

The mobile app uses a feature-first structure. Expo Router files stay deliberately thin: `src/app`
defines URLs, route groups, guards, and navigator options, while screen implementations live with
the feature that owns them.

```text
src/
  app/                  Expo Router routes and layouts only
    (app)/              routes available to an authenticated session
  features/
    auth/               QR sign-in, session storage, and session context
    bots/               bot list, bot actions, and pin transitions
    chat/               chat screen and its focused UI sections
    search/             search model, controls, results, and screen
    servers/            server drawer and joining a server
    settings/           account settings screen
    workspace/          remote directory, WebRTC transport, live events, and workspace state
  shared/
    components/         UI used by more than one feature
    lib/                platform and infrastructure helpers
```

Keep code inside a feature until a second feature needs it. Move it to `shared` only when it has no
feature-specific behavior. Shared code must not import from features; direct feature-to-feature reuse
should stay explicit so it cannot turn into an accidental circular dependency.
Split screens into focused sections when they combine navigation, local state, and multiple distinct
UI regions; for example, chat owns separate header, message-list, and composer components.

## Design development

The mobile design system is documented in [`DESIGN.md`](./DESIGN.md). Read it before implementing or reviewing UI.

In short, use HeroUI Native for application content and reusable product components. Use native Expo Router and `@expo/ui` surfaces for navigation, headers, tabs, toolbars, search, menus, and route-level sheets so each platform owns its chrome and iOS can render Liquid Glass where the operating system supports it.

## Verification

```bash
bun run mobile:lint
bun run mobile:typecheck
bun run mobile:doctor
```

## EAS

The project is linked to EAS and has development, preview, and production build profiles in `eas.json`.

```bash
cd apps/mobile
bunx eas-cli@latest build --profile development --platform ios
bunx eas-cli@latest build --profile development --platform android
```

Cloud builds require the final `ios.bundleIdentifier` and `android.package` values in `app.json`. Store submission also requires Apple Developer and Google Play Console credentials.
