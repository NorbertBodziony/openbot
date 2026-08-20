import { createFileRoute } from "@tanstack/solid-router";
import { LandingPage } from "../components/landing/LandingPage";

export const Route = createFileRoute("/")({ component: LandingPage });
