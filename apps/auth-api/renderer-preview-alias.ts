import { fileURLToPath } from "node:url";

export const rendererPreviewAlias = fileURLToPath(
  new URL("../../src/renderer/src/preview/OpenBotPlayground.tsx", import.meta.url),
);

export const landingPreviewAlias = fileURLToPath(
  new URL("../../src/renderer/src/preview/LandingPreviewApp.tsx", import.meta.url),
);
