import { createFileRoute } from "@tanstack/solid-router";
import { json } from "../../server/request-auth";

export const Route = createFileRoute("/health/live")({
  server: {
    handlers: {
      GET: async () => json({ service: "openbot-auth-api", status: "ok" }),
    },
  },
});
