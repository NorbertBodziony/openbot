import { renderToString } from "@solidjs/web";
import { describe, expect, it } from "vitest";
import { AppPreviewPage } from "../src/routes/app-preview.lazy";

describe("landing page", () => {
  it("keeps the application preview SSR-safe until hydration", () => {
    expect(() => renderToString(() => <AppPreviewPage />)).not.toThrow();
    const markup = renderToString(() => <AppPreviewPage />);

    expect(markup).toContain('id="root"');
    expect(markup).not.toContain('aria-label="Bot navigation"');
  });
});
