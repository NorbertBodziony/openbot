# Contributing to OpenBot

Thanks for helping improve OpenBot. Small, focused pull requests with clear verification are the
easiest to review.

## Before opening an issue

- Search existing issues first.
- Use the security process in `SECURITY.md` for vulnerabilities.
- Remove credentials, private file paths, conversation contents, and personal data from diagnostics.
- Include the OpenBot version, macOS version, Mac architecture, provider, CLI version, and
  reproduction steps for bugs.

## Development setup

```bash
git clone https://github.com/NorbertBodziony/openbot.git
cd openbot
bun install --frozen-lockfile
bun run check
bun run dev
```

The supported toolchain is pinned in `package.json`. Use stable Bun 1.4.0, TypeScript 5.9, Vite 7, and the
existing Biome configuration. Biome is the only lint and format tool. Do not add a second linter,
Prettier, a second state library, or a UI kit without first discussing the architectural cost.
The Biome configuration also loads the repository-owned GritQL rules in
`tools/biome/anti-slop/rules`. Fix these findings at the domain boundary. Do not suppress a rule or
replace a concrete contract with a broad dictionary type.

Biome's `suspicious/noImportCycles` rejects circular imports across the whole repository, so runtime
imports point in one direction. When two modules need each other, move the shared piece into a third
module both can import — as `app-controller-context.tsx` and `conversation-controller-context.tsx` do
for their controller contexts. Type-only imports (`import type`) are erased by the compiler and stay
allowed in both directions.

## Pull requests

1. Create a branch from `main`.
2. Keep behavior and visual changes scoped to the issue being solved.
3. Add or update tests for behavior changes and reproduced bugs.
4. Run `bun run check`. Coding agents do not: see `AGENTS.md` "Do not run repo-wide checks".
5. Describe user-visible changes, risks, and manual verification in the pull request.

Do not commit generated `out`, `dist`, coverage, local browser profiles, Electron `userData`, CLI
state, `.env` files, credentials, real conversations, or user attachments.

## Security-sensitive changes

Preserve the following boundaries and their tests:

- Electron sandboxing, context isolation, navigation policy, and IPC sender validation.
- Attachment realpath, MIME, size, quota, and managed-protocol checks.
- Queue serialization, idempotency, crash reconciliation, and atomic persistence.
- The remote browser session's lack of preload and `window.openbot` access.
- Secret redaction and agent child-process cleanup.

Full agent access is intentional today, but new privileges or network surfaces still require an
explicit threat-model note in the pull request.

## Dependencies

Prefer the platform and existing dependencies. A new runtime dependency should remove more
complexity than it adds, have a compatible open-source license, and be justified in the pull request.
Keep tool versions pinned; compatibility upgrades should be isolated and verified by the full check.

## Licensing

By submitting a contribution, you agree that it is your original work (or that you have the right to
submit it) and that it is licensed under the repository's PolyForm Noncommercial 1.0.0 license. Do
not submit copied UI assets, proprietary code, private plugin binaries, or material whose license is
unclear.
