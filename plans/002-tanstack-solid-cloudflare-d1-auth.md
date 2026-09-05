# Plan 002: TanStack Start, Solid 2, Cloudflare Workers and D1

## Goal

The central account server runs as a separate TanStack Start application with
Solid 2. Cloudflare Workers hosts the application. D1 stores users, short-lived
sign-in data and OpenBot sessions.

## Account contract

- A unique email address identifies the user to the hosts.
- The API sends a one-time code in the `XXXX-XXXX` format.
- The code uses 32 safe characters and carries about 40 bits of entropy.
- The code is valid for 10 minutes and can be used only once.
- D1 stores only a hash of the code.
- The API neither accepts nor stores an OpenBot password.
- The API stores only a hash of the OpenBot session token.
- Electron stores the encrypted session token through `safeStorage`.

## Limits

- At most 5 new codes per email within 15 minutes.
- At most 20 new codes per IP within 15 minutes.
- At least 60 seconds between codes for the same email.
- At most 5 failed attempts per code.
- At most 30 verification attempts per IP within 15 minutes.

## Flow

1. Electron sends the email to `POST /v1/auth/email/start`.
2. The API stores the code hash and the expiry in D1.
3. The delivery adapter hands the code to the email service.
4. The user types the code into the app.
5. Electron calls `POST /v1/auth/email/verify`.
6. The API consumes the code and returns an OpenBot session.

## Connection to the host whitelist

- The next stage changes a team member into `centralUserId + email + role`.
- The host stores neither the password nor the nickname of a member.
- The central API issues a short, signed ticket for one specific host.
- The host validates the ticket and the local email or user ID whitelist.

## Commands

- `bun run api` starts the local Worker and D1.
- `bun run dev` starts the Electron client.
- `bun run host` starts a separate host profile.
- `bun run dev:all` starts the API, the client and the host.
- `bun run api:migrate:local` applies the local D1 migrations.
- `bun run api:deploy` deploys the Worker once the Cloudflare configuration is set.
