import type { JSX } from "@solidjs/web";
import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/solid-router";
import "@openbot/brand/logo.css";
import "../styles.css";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "OpenBot — Persistent AI teammates" },
      {
        name: "description",
        content: "A local-first desktop workspace for persistent Codex and Claude teammates.",
      },
      { name: "theme-color", content: "#070707" },
    ],
  }),
  component: RootComponent,
  shellComponent: RootDocument,
});

function RootComponent() {
  return <Outlet />;
}

function RootDocument(props: { children: JSX.Element }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {props.children}
        <Scripts />
      </body>
    </html>
  );
}
