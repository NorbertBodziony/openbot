import { createFileRoute } from "@tanstack/solid-router";

export const Route = createFileRoute("/")({ component: AccountServicePage });

function AccountServicePage() {
  return (
    <main
      style={{
        "max-width": "44rem",
        margin: "4rem auto",
        padding: "0 1.5rem",
        "font-family": "system-ui, sans-serif",
        color: "#171717",
      }}
    >
      <p style={{ color: "#5b5b5b", "font-weight": 600 }}>OPENBOT</p>
      <h1>Account service</h1>
      <p>This Cloudflare Worker provides one-time email code sign-in for OpenBot.</p>
    </main>
  );
}
