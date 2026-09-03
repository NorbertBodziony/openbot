import { renderToString } from "@solidjs/web";
import { describe, expect, it } from "vitest";
import { AppPreviewPage } from "../src/routes/app-preview.lazy";

describe("landing page", () => {
  it("serves the loading fallback and no hydrated content until the preview mounts", () => {
    const markup = renderToString(() => <AppPreviewPage />);

    expect(markup).toContain('aria-label="Loading OpenBot preview"');
    expect(markup).not.toContain('aria-label="Bot navigation"');
  });
});
