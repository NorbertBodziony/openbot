import { LandingPreviewApp } from "@openbot/landing-preview";
import { createLazyFileRoute } from "@tanstack/solid-router";

export const Route = createLazyFileRoute("/app-preview")({ component: AppPreviewPage });

export function AppPreviewPage() {
  return (
    <div id="root" class="openbot-playground-root" data-preview-variant="landing">
      <LandingPreviewApp />
    </div>
  );
}
