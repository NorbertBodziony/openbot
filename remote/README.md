# OpenBot Remote

This directory holds our own control plane for WebRTC connections. The Remote API relays SDP and ICE only.
Files, chats, commands and video never pass through the Remote API or Cloudflare.

## Flow

1. The app signs the user in through the Cloudflare API.
2. Cloudflare D1 checks membership and creates a logical session.
3. Cloudflare signs a short ES256 ticket. The ticket names the host, the user, the role, the protocol version and `authEpoch`.
4. The client and the host open `WSS /v1/signal`. Signal validates the ticket locally through JWKS.
5. Signal relays SDP and ICE and issues a `resume token` along with time-limited coturn credentials.
6. Chromium sets up WebRTC. The Team API uses the `rpc`, `events` and `files` channels.
7. ICE picks either a direct `p2p` path or `relay` through this coturn. Cloudflare is never on the data path.

Signal has no database. It stores no tokens, SDP, ICE, file names or message contents. Room and presence
data exist only in process memory.

A `resume token` is valid for 10 minutes. Signal keeps the issued token in a bounded in-memory cache.
A normal reconnect validates that token locally. After a Signal restart the cache is empty, so the first
reconnect for a given token makes one signed request to the control plane. The same request is needed once
the token has expired. The control plane checks the session, the membership and `authEpoch`. Signal then
issues a new token. Subsequent reconnects are local again. There are no heartbeats and no periodic refresh
through Cloudflare.

Ending a session and changing access both write a revocation event to a durable D1 outbox. The Worker tries
to deliver it to Signal immediately. If Signal is unreachable, the Worker retries the delivery from cron. An
ordinary reconnect still does not ask Cloudflare. Ended and expired sessions are removed after the 10-minute
validation window.

## Production requirements

- Linux with Docker Engine and Docker Compose.
- A static public IPv4 address.
- `signal.openbot.run` and `turn.openbot.run` records in DNS only mode.
- Open ports TCP 443, TCP/UDP 3478, TCP 5349 and UDP 49152-65535.
- A Cloudflare token scoped to DNS edit for the `openbot.run` zone.

The `signal.openbot.run` and `turn.openbot.run` records must be in **DNS only** mode. Do not enable the
Cloudflare proxy for them. `api.openbot.run` stays a Cloudflare Worker.

If you already run a reverse proxy on port `443`, set `REMOTE_SIGNAL_BIND_ADDRESS=127.0.0.1`,
`REMOTE_SIGNAL_PUBLIC_PORT=8081`, `REMOTE_SIGNAL_PORT=8081` and `REMOTE_TLS_DISABLED=true`. The reverse proxy
must terminate TLS and forward the WebSocket to `http://127.0.0.1:8081`. Also set
`REMOTE_TRUST_PROXY=true` so the IP limits use the client address from `X-Forwarded-For`.

The configuration in `nginx/signal.openbot.run.conf` uses the certificate from the ACME volume. Install
`openbot-remote-nginx-reload.path` and `openbot-remote-nginx-reload.service` into `/etc/systemd/system/` as
well. The unit reloads Nginx after the certificate is renewed:

```sh
sudo cp remote/nginx/openbot-remote-nginx-reload.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now openbot-remote-nginx-reload.path
```

Production secrets are stored in the tracked `.env.production` file as encrypted Dotenvx values.
The private decryption key lives only in the ignored `remote/.env.keys` file. Do not pass the encrypted
file straight to `docker compose --env-file`, because Compose will not decrypt the values.
The `remote:*` scripts run Compose through Dotenvx and decrypt the values only in process memory.
The `--overload` option keeps empty host environment variables from overriding the decrypted values.
The scripts use `remote/bin/dotenvx`. The wrapper picks the pinned Node from the application runtime if the
system Node is too old.

Validate the environment and start the services:

```sh
bun run remote:env:validate
bun run remote:up
bun run remote:check
```

Updating Signal may close the WebSocket. An active WebRTC connection stays up. `remote:update` puts coturn
into drain and waits for the allocations to finish. A single coturn instance is no protection against machine
failure. Forcing a coturn restart ends active relay sessions. The client performs an ICE restart and resumes
a file transfer from the last acknowledged offset once the service is back.

The first version supports one active logical client session per host. Reconnecting the same session replaces
the old Signal socket. A second session gets a `host_busy` error and can retry once the first session has
ended.
