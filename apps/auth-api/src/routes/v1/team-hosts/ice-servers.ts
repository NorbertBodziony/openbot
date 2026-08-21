import { createFileRoute } from "@tanstack/solid-router";
import { requestTeamHostAuthenticator } from "../../../server/request-auth";
import { handleTeamHostIceServers } from "../../../server/team-host-ice-servers";

export const Route = createFileRoute("/v1/team-hosts/ice-servers")({
  server: {
    handlers: {
      POST: ({ request }) =>
        handleTeamHostIceServers(request, {
          authenticateHost: requestTeamHostAuthenticator(),
        }),
    },
  },
});
