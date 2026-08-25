import { createFileRoute } from "@tanstack/solid-router";
import { LandingPage } from "../components/landing/LandingPage";
import { openBotHomeHead } from "../lib/site-metadata";

export const Route = createFileRoute("/")({
  head: openBotHomeHead,
  component: LandingPage,
});
