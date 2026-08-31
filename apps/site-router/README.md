# OpenBot site hosting deployment

This Worker is the public, read-only application path for `*.openbot.site`. The Auth API is the only application component that writes or deletes site objects. Do not enable an R2 public development URL or a custom R2 domain.

## One-time Cloudflare setup

1. Use the same Cloudflare account as `openbot.site`.
2. Create the private Standard bucket with `bun run sites:bucket:create`.
3. Create `openbot-sites-test` for preview and test deployments.
4. Add a proxied wildcard `AAAA` record. Use name `*` and placeholder value `100::`.
5. Confirm that Universal SSL covers `*.openbot.site`.
6. Apply the lifecycle rule with `bun run sites:lifecycle`.
7. Add `openbot.site` to the Public Suffix List and confirm the deployed list contains it. This is a launch requirement because tenant JavaScript can otherwise set cookies for sibling sites.

R2 bindings do not have a per-binding read-only mode. The router has no mutation route and its code only calls `get`. Limit the deployment credentials for the router to the minimum Worker deployment permissions. Keep Auth API deployment credentials separate from public request handling.

## Release order

1. Keep `SITE_PUBLISH_ENABLED`, `SITE_COOKIE_ISOLATION_READY`, and `SITE_SERVE_ENABLED` absent or set to `false`.
2. Deploy the router with `bun run sites:deploy`.
3. Deploy the Auth API. Its deployment command applies D1 migrations `0012_hosted_sites.sql`,
   `0013_hosted_site_hostname_reservations.sql`, `0014_hosted_site_object_cleanup.sql`, and
   `0015_hosted_site_activation_authorization.sql` before the Worker update.
4. Confirm that `openbot.site` is present in the Public Suffix List.
5. Set all three launch flags to `true` and deploy the router and Auth API again.
6. Check three generated hostnames over HTTPS.
7. Publish one vanilla site and one Astro static site.
8. Replace one site and confirm that its hostname stays the same.
9. Delete one site and confirm `410 Gone` and `X-Robots-Tag: noindex, nofollow`.

Set the three launch switches as protected production Worker variables in Cloudflare. Production deploys use `--keep-vars`, so later releases do not overwrite these values with repository defaults. An absent value remains disabled. Set `SITE_PUBLISH_ENABLED` to `false` on the Auth API to stop new uploads and activations. Set `SITE_SERVE_ENABLED` to `false` on the router to stop public serving. The admin endpoint `POST /v1/sites/admin/:siteId/block` blocks one site. `DELETE` on the same endpoint removes the block when the deployment is still valid.

Set a dedicated `SITE_OPERATIONS_ADMIN_TOKEN` secret before using the block endpoint. If the secret is absent, the endpoint stays closed. Do not reuse `SKILLS_ADMIN_TOKEN`.
