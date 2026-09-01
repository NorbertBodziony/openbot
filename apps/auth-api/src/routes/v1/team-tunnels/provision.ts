import { createFileRoute } from "@tanstack/solid-router";
import { apiError } from "../../../server/request-auth";

function retiredTunnelResponse(): Response {
  return apiError(426, "host_update_required", "Update OpenBot on the host to use WebRTC Remote.");
}

export const Route = createFileRoute("/v1/team-tunnels/provision")({
  server: {
    handlers: {
      POST: retiredTunnelResponse,
      DELETE: retiredTunnelResponse,
    },
  },
});
