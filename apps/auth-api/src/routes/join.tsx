import { createFileRoute } from "@tanstack/solid-router";
import { JoinPage } from "../components/landing/JoinPage";

export const Route = createFileRoute("/join")({
  head: () => ({
    meta: [
      { title: "Open an OpenBot invitation" },
      { name: "robots", content: "noindex, nofollow, noarchive" },
      { name: "referrer", content: "no-referrer" },
      {
        name: "description",
        content: "Open a private host invitation in the OpenBot desktop app.",
      },
    ],
  }),
  headers: () => ({
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
  }),
  component: JoinPage,
});
