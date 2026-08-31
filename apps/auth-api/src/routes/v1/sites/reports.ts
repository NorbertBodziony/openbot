import { createFileRoute } from "@tanstack/solid-router";
import {
  apiError,
  hostedSiteErrorResponse,
  json,
  requestHostedSiteService,
  requestSourceIp,
} from "../../../server/request-auth";

export const Route = createFileRoute("/v1/sites/reports")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const length = Number(request.headers.get("Content-Length"));
          if (Number.isFinite(length) && length > 4_096) {
            return apiError(413, "request_too_large", "The report is too large.");
          }
          const contentType = request.headers.get("Content-Type") ?? "";
          if (!contentType.startsWith("application/x-www-form-urlencoded")) {
            return apiError(400, "invalid_report", "The report form is invalid.");
          }
          const body = await request.text();
          if (body.length > 4_096) return apiError(413, "request_too_large", "The report is too large.");
          const form = new URLSearchParams(body);
          const hostname = form.get("hostname")?.trim().toLowerCase() ?? "";
          const reason = form.get("reason")?.trim().toLowerCase() ?? "";
          const details = form.get("details")?.trim() || null;
          await requestHostedSiteService().report(hostname, reason, details, requestSourceIp(request));
          return json({ reported: true }, 201);
        } catch (error) {
          return hostedSiteErrorResponse(error);
        }
      },
    },
  },
});
