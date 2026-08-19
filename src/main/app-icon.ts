import { join } from "node:path";
import type { AppVariant } from "@openbot/contracts/ipc";

const APP_VARIANTS = ["production", "dev", "preview"] as const satisfies readonly AppVariant[];

export function readAppVariant(value: string | undefined, isPackaged: boolean): AppVariant {
  if (isAppVariant(value)) return value;
  return isPackaged ? "production" : "dev";
}

export function appIconFileName(variant: AppVariant): string {
  return `icon-${variant}.png`;
}

export function resolveAppIconPath(options: {
  variant: AppVariant;
  isPackaged: boolean;
  resourcesPath: string;
  sourceRoot: string;
}): string {
  return options.isPackaged
    ? join(options.resourcesPath, "icons", appIconFileName(options.variant))
    : join(options.sourceRoot, "build", appIconFileName(options.variant));
}

function isAppVariant(value: string | undefined): value is AppVariant {
  return APP_VARIANTS.some((variant) => variant === value);
}
