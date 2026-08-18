# OpenBot Auth API

This TanStack Start and Solid 2 package is the central OpenBot account API. It
runs on Cloudflare Workers and stores data in D1. Users sign in with an
eight-character one-time email code. The API stores only code hashes and OpenBot
session-token hashes.

## Local development

The repository contains encrypted `.env.dev` and `.env.production` files. The
private keys stay in the ignored root `.env.keys` file. Dotenvx decrypts the
selected file only in process memory. The explicit development flag returns the
code in the API response. It never writes the code to logs.

```bash
bun run api:migrate:local
bun run api
```

The local address is `http://127.0.0.1:3100`.

Update and validate the encrypted files with these commands:

```bash
bunx dotenvx set AUTH_EXPOSE_DEVELOPMENT_CODE true -f apps/auth-api/.env.dev -fk .env.keys
printf '%s' '<APP_PASSWORD>' | bun run env:set:smtp
bun run env:validate:dev
bun run env:validate:prod
```

Commit `.env.dev` and `.env.production`. Never commit `.env.keys`.

## Email delivery

Private Email SMTP is the primary delivery method. Use a separate app password.
Do not use the mailbox password. For local development, put the values in the
ignored `.dev.vars` file:

```dotenv
EMAIL_SMTP_HOST=mail.privateemail.com
EMAIL_SMTP_PORT=465
EMAIL_SMTP_USERNAME=hello@openbot.run
EMAIL_SMTP_PASSWORD=<PRIVATE_EMAIL_APP_PASSWORD>
EMAIL_FROM=hello@openbot.run
```

For a deployed Worker, `bun run api:deploy` decrypts `.env.production`, sends
`EMAIL_SMTP_PASSWORD` to `wrangler secret put` through standard input, builds the
Worker, and deploys it. The password is never passed as a process argument. The
other values are Worker variables. The SMTP connection uses TLS from the start
and accepts only port 465.

Use `bun run api:deploy:test` for the isolated `openbot-auth-api-test` Worker
and the `openbot-auth-test` D1 database.

As a fallback, set `EMAIL_DELIVERY_WEBHOOK_URL` to an HTTPS endpoint. OpenBot
sends this JSON:

```json
{
  "email": "person@example.com",
  "code": "ABCD-EFGH",
  "expiresAt": 1787060000000
}
```

If `EMAIL_DELIVERY_WEBHOOK_SECRET` is set, the request includes a Bearer token.
Do not enable `AUTH_EXPOSE_DEVELOPMENT_CODE` in production.

## Cloudflare deployment

Create the D1 database and replace the placeholder `database_id` in
`wrangler.jsonc`. Apply remote migrations and set delivery secrets through
Wrangler. Then deploy the Worker.

```bash
bun run api:migrate:remote
bun run api:deploy
```

The service applies limits per email, per IP, per challenge, and per resend.
