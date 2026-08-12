# Support

OpenBot is an early open-source project maintained on a best-effort basis.

- Use GitHub Issues for reproducible bugs and focused feature requests.
- Use GitHub Discussions for setup questions, ideas, and general help.
- Use the private process in `SECURITY.md` for vulnerabilities.

If you installed a release, first confirm that `codex --version` works in Terminal and run
`codex login`. Restart OpenBot after signing in. See [Troubleshooting](docs/TROUBLESHOOTING.md) for
safe reset and uninstall steps.

If you are developing from source, run:

```bash
bun run codex:doctor
bun run check
```

Share only the relevant, redacted output. Never post credentials, private files, conversation
contents, `~/.codex`, Electron `userData`, or full unreviewed stderr in public.
