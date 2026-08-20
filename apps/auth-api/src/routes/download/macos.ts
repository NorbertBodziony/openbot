import { createFileRoute } from "@tanstack/solid-router";
import { latestDownloadResponse } from "../../server/latest-download";

export const Route = createFileRoute("/download/macos")({
  server: {
    handlers: {
      GET: async () => latestDownloadResponse("macos"),
    },
  },
});
