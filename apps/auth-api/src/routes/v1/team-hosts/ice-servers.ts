import { createFileRoute } from "@tanstack/solid-router";
import { apiError } from "../../../server/request-auth";

export const Route = createFileRoute("/v1/team-hosts/ice-servers")({
  server: {
    handlers: {
      POST: () =>
        apiError(426, "host_update_required", "Update OpenBot on the host to get ICE credentials from Remote Signal."),
    },
  },
});
