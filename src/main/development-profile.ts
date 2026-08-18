export type DevelopmentProfile = "app" | "host";

export function readDevelopmentProfile(value: string | undefined): DevelopmentProfile {
  return value === "host" ? "host" : "app";
}

export function developmentUserDataName(profile: DevelopmentProfile): string {
  return profile === "host" ? "OpenBot Dev Host" : "OpenBot Dev";
}

export function shouldAutoStartHost(input: {
  configured: boolean;
  enabledOnLaunch: boolean;
  forcedByDevelopmentScript: boolean;
}): boolean {
  return input.configured && (input.enabledOnLaunch || input.forcedByDevelopmentScript);
}
