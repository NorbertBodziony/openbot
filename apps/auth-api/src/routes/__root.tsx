import type { JSX } from "@solidjs/web";
import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/solid-router";
import "@openbot/brand/logo.css";
import "../styles.css";
import { OPENBOT_SECURITY_HEADERS, openBotRootHead } from "../lib/site-metadata";

export const Route = createRootRoute({
  head: openBotRootHead,
  headers: () => OPENBOT_SECURITY_HEADERS,
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
