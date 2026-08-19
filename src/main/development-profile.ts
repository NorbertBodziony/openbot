export type DevelopmentProfile = "app" | "test-client";

export function readDevelopmentProfile(value: string | undefined): DevelopmentProfile {
  return value === "test-client" ? "test-client" : "app";
}

export function developmentUserDataName(profile: DevelopmentProfile): string {
  return profile === "test-client" ? "OpenBot Dev Test Client" : "OpenBot Dev";
}

export function shouldAutoStartHost(input: {
  configured: boolean;
  enabledOnLaunch: boolean;
}): boolean {
  return input.configured && input.enabledOnLaunch;
}
