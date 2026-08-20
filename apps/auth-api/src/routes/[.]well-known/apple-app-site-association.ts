import { createFileRoute } from "@tanstack/solid-router";

export const APPLE_APP_SITE_ASSOCIATION = {
  applinks: {
    apps: [],
    details: [
      {
        appID: "ZTRDTUL87R.app.openbot.desktop",
        paths: ["/join"],
      },
    ],
  },
};

export function createAppleAppSiteAssociationResponse(): Response {
  return new Response(JSON.stringify(APPLE_APP_SITE_ASSOCIATION), {
    headers: {
      "Cache-Control": "public, max-age=3600",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

export const Route = createFileRoute("/.well-known/apple-app-site-association")({
  server: {
    handlers: {
      GET: createAppleAppSiteAssociationResponse,
    },
  },
});
