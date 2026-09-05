---
name: openbot-site-hosting
description: Build, publish, replace, list, and delete small static websites hosted by OpenBot. Use when the user asks to host or manage a site on openbot.site.
---

# OpenBot site hosting

Use vanilla HTML, CSS, and JavaScript by default. Prefer semantic HTML, CSS variables, native Web APIs, and Web Components. Do not add React, Vue, Svelte, jQuery, or another runtime framework. Do not add a library for one simple component. Do not use CDN scripts unless the user has a clear need.

Use Astro only for a site with multiple pages, shared layouts, or repeated components. Astro must use `output: "static"`. Do not add a server adapter, SSR, API routes, server actions, React integration, or client hydration by default. Publish only the existing `dist/` output. Do not install a dependency unless the user explicitly approves it.

Hosting is public. A user can have 10 active sites. One site can contain at most 20 files and 2 MB in total. One file can be at most 1 MB. A successful publish or replacement expires after 30 days. Replacement keeps the hostname and starts a new 30-day period.

Every site must contain `index.html`. Allowed files are HTML, CSS, JavaScript, JSON, SVG, WebP, PNG, JPEG, ICO, WOFF2, TXT, and web manifests. Do not publish symlinks, archives, source maps, executables, `.env` files, keys, server source, or unsafe paths.

Use these tools:

- `openbot.list_sites` lists the user's sites. Use it before a retry.
- `openbot.publish_site` publishes a new site from this agent's workspace or OpenBot Shared.
- `openbot.replace_site` replaces one owned site and keeps its URL.
- `openbot.delete_site` deletes one owned site and makes its URL return `410 Gone`.

Call a hosting mutation tool only after the user gives an explicit publish, replace, or delete instruction. A request to build, preview, discuss, or review a site is not permission to publish it. Never ask for or use R2 credentials, R2 tokens, presigned URLs, or direct Cloudflare API access.
