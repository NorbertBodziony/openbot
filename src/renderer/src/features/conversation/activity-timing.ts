export function rendererDuration(property: string, fallback: number): number {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return 0;
  const value = getComputedStyle(document.documentElement).getPropertyValue(property).trim();
  if (value.endsWith("ms")) return Number.parseFloat(value) || fallback;
  if (value.endsWith("s")) return (Number.parseFloat(value) || fallback / 1_000) * 1_000;
  return fallback;
}

export function agentActivityExitDuration(): number {
  return rendererDuration("--openbot-duration-overlay", 240);
}

export function agentActivityShowDelay(): number {
  return rendererDuration("--openbot-duration-fast", 120);
}

export function agentActivityExitDelay(): number {
  return rendererDuration("--openbot-agent-activity-exit-delay", 500);
}
