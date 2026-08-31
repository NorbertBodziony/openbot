# OpenBot site hosting deployment

This Worker is the public, read-only application path for `*.openbot.site`. The Auth API is the only application component that writes or deletes site objects. Do not enable an R2 public development URL or a custom R2 domain.

## One-time Cloudflare setup

1. Use the same Cloudflare account as `openbot.site`.
2. Create the private Standard bucket with `bun run sites:bucket:create`.
3. Create `openbot-sites-test` for preview and test deployments.
4. Add a proxied wildcard `AAAA` record. Use name `*` and placeholder value `100::`.
5. Confirm that Universal SSL covers `*.openbot.site`.
6. Apply the lifecycle rule with `bun run sites:lifecycle`.
7. Submit `openbot.site` to the Public Suffix List after launch. This is a later isolation improvement, not a launch dependency.

R2 bindings do not have a per-binding read-only mode. The router has no mutation route and its code only calls `get`. Limit the deployment credentials for the router to the minimum Worker deployment permissions. Keep Auth API deployment credentials separate from public request handling.

## Release order

1. Deploy the Auth API. Its deployment command applies D1 migrations `0012_hosted_sites.sql` and
   `0013_hosted_site_hostname_reservations.sql` before the Worker update.
2. Deploy the router with `bun run sites:deploy`.
3. Check three generated hostnames over HTTPS.
4. Publish one vanilla site and one Astro static site.
5. Replace one site and confirm that its hostname stays the same.
6. Delete one site and confirm `410 Gone` and `X-Robots-Tag: noindex, nofollow`.

Set `SITE_PUBLISH_ENABLED` to `false` on the Auth API to stop new uploads and activations. Set `SITE_SERVE_ENABLED` to `false` on the router to stop public serving. The admin endpoint `POST /v1/sites/admin/:siteId/block` blocks one site. `DELETE` on the same endpoint removes the block when the deployment is still valid.
