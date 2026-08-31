import { describe, expect, it } from "vitest";
import { parseHostedSiteUploadRequest } from "../src/server/hosted-site-contract";

function request(files: Array<{ path: string; size: number; mimeType: string }>) {
  return {
    title: "Student budget planner",
    description: "An interactive budget planner for university students.",
    framework: "vanilla",
    spaFallback: false,
    siteId: null,
    files,
  };
}

describe("hosted site manifest", () => {
  it("accepts a 2 MB site with 20 allowed files", () => {
    const files = [
      { path: "index.html", size: 1024 * 1024, mimeType: "text/html" },
      { path: "assets/app.js", size: 1024 * 1024 - 18, mimeType: "text/javascript" },
      ...Array.from({ length: 18 }, (_, index) => ({
        path: `assets/empty-${index}.txt`,
        size: 1,
        mimeType: "text/plain",
      })),
    ];
    expect(parseHostedSiteUploadRequest(request(files)).files).toHaveLength(20);
  });

  it.each([
    ["../secret.txt", "text/plain"],
    [".env", "text/plain"],
    ["service-account.json", "application/json"],
    ["private-key.txt", "text/plain"],
    ["server.js", "text/javascript"],
    ["assets/source.js.map", "application/json"],
    ["bundle.zip", "application/zip"],
  ])("rejects unsafe file %s", (path, mimeType) => {
    expect(() =>
      parseHostedSiteUploadRequest(
        request([
          { path: "index.html", size: 10, mimeType: "text/html" },
          { path, size: 10, mimeType },
        ]),
      ),
    ).toThrow();
  });

  it("rejects a file above 1 MB and a site above 2 MB", () => {
    expect(() =>
      parseHostedSiteUploadRequest(request([{ path: "index.html", size: 1024 * 1024 + 1, mimeType: "text/html" }])),
    ).toThrow("1 MB");
    expect(() =>
      parseHostedSiteUploadRequest(
        request([
          { path: "index.html", size: 1024 * 1024, mimeType: "text/html" },
          { path: "app.js", size: 1024 * 1024, mimeType: "text/javascript" },
          { path: "extra.txt", size: 1, mimeType: "text/plain" },
        ]),
      ),
    ).toThrow("2 MB");
  });

  it("requires a root index.html", () => {
    expect(() =>
      parseHostedSiteUploadRequest(request([{ path: "pages/index.html", size: 10, mimeType: "text/html" }])),
    ).toThrow("root");
  });
});
