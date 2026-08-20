import { describe, expect, it } from "vitest";
import {
  APPLE_APP_SITE_ASSOCIATION,
  createAppleAppSiteAssociationResponse,
} from "../src/routes/[.]well-known/apple-app-site-association";

describe("Apple app site association", () => {
  it("associates only the canonical invitation path with the signed desktop app", async () => {
    const response = createAppleAppSiteAssociationResponse();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    await expect(response.json()).resolves.toEqual(APPLE_APP_SITE_ASSOCIATION);
    expect(APPLE_APP_SITE_ASSOCIATION.applinks.details).toEqual([
      {
        appID: "ZTRDTUL87R.app.openbot.desktop",
        paths: ["/join"],
      },
    ]);
  });
});
