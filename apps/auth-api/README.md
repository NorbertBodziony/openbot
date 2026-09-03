# OpenBot Auth API

This TanStack Start and Solid 2 package is the central OpenBot account API. It
runs on Cloudflare Workers, stores account and authentication records in D1,
and stores account avatars in R2. Users sign in with an eight-character
one-time email code. D1 stores hashes instead of plaintext codes, session tokens,
and team authentication tickets.

## Local development

The repository contains encrypted `.env.dev` and `.env.production` files. The
private keys stay in the ignored root `.env.keys` file. Dotenvx decrypts the
selected file only in process memory. The explicit development flag returns the
code in the API response. It never writes the code to logs.

```bash
bun run api:migrate:local
bun run dev:api
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
SITE_REPORT_HASH_SECRET=<AT_LEAST_32_RANDOM_CHARACTERS>
```

For a deployed Worker, `bun run api:deploy` decrypts `.env.production`. It sends
`EMAIL_SMTP_PASSWORD`, `SKILLS_ADMIN_TOKEN`, `REMOTE_TICKET_PRIVATE_JWK`,
`REMOTE_TICKET_PUBLIC_JWKS`, `REMOTE_AUTH_WEBHOOK_SECRET`, and `SITE_REPORT_HASH_SECRET` to
`wrangler secret put` through standard input. It then builds and deploys the Worker.
Secrets are never passed as process arguments. The other values are Worker
variables. The SMTP connection uses TLS from the start and accepts only port 465.

GitHub Actions reads the remote-control secrets, `SKILLS_ADMIN_TOKEN`, `SITE_REPORT_HASH_SECRET`, and the optional
`SITE_OPERATIONS_ADMIN_TOKEN` from the `cloudflare-production` Environment. It includes them in Wrangler's temporary
runtime secrets file.

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

## Authentication data retention

The production Worker runs once each minute. Each run delivers pending remote
authorization events and cleans up hosted sites. The midnight UTC run also deletes
expired or consumed email challenges, expired or revoked sessions, expired or
consumed team authentication tickets, and expired rate-limit records. A successful
retention run logs only aggregate deletion counts.

The `preview` and `test` environments do not install an automatic Cron Trigger.
To run the scheduled handler during local development, start the API and request
the Cloudflare scheduled-handler test route:

```bash
curl "http://127.0.0.1:3100/cdn-cgi/handler/scheduled?cron=*+*+*+*+*"
```

## Remote control plane

The Auth API stores remote hosts, memberships, invitations, and logical sessions.
It issues short-lived ES256 connection tickets. `/.well-known/jwks.json` publishes
the public key so the separate Signal service can verify tickets without a D1
request. The old Team Tunnel provisioning endpoint returns `426` and does not
create a Cloudflare Tunnel.

Set the private JWK, public JWKS, active key ID, Signal URL, and webhook secret in
the encrypted environment. The private and public keys must use ES256. The Signal
URL must point to a DNS-only host. Cloudflare carries only account and configuration
requests. It does not carry Team API or Remote Desktop data.
