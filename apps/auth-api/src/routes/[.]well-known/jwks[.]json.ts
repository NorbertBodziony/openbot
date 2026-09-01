import { createFileRoute } from "@tanstack/solid-router";
import { requestRemoteControlPlane } from "../../server/request-auth";

export function createRemoteJwksResponse(): Response {
  return Response.json(requestRemoteControlPlane().publicJwks(), {
    headers: { "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" },
  });
}

export const Route = createFileRoute("/.well-known/jwks.json")({
  server: { handlers: { GET: createRemoteJwksResponse } },
});
