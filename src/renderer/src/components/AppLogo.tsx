import type { AppVariant } from "@openbot/contracts/ipc";
import devLogoUrl from "../assets/openbot-logo-dev.png";
import previewLogoUrl from "../assets/openbot-logo-preview.png";
import productionLogoUrl from "../assets/openbot-logo-production.png";

const LOGO_URLS: Record<AppVariant, string> = {
  production: productionLogoUrl,
  dev: devLogoUrl,
  preview: previewLogoUrl,
};

export type AppLogoAnimation = "none" | "blink" | "look-around" | "surprised";

interface AppLogoProps {
  variant: AppVariant;
  animation?: AppLogoAnimation;
  class?: string;
}

export function AppLogo(props: AppLogoProps) {
  const className = () => ["app-logo", props.class].filter(Boolean).join(" ");
  const animation = () => props.animation ?? "none";
  const logoUrl = () => LOGO_URLS[props.variant];

  return (
    <span class={className()} data-animation={animation()} data-variant={props.variant} aria-hidden="true">
      <img class="app-logo-image" src={logoUrl()} alt="" />
      <span class="app-logo-eye-mask app-logo-eye-mask-left" />
      <span class="app-logo-eye-mask app-logo-eye-mask-right" />
      <img class="app-logo-image app-logo-eye app-logo-eye-left" src={logoUrl()} alt="" />
      <img class="app-logo-image app-logo-eye app-logo-eye-right" src={logoUrl()} alt="" />
    </span>
  );
}
