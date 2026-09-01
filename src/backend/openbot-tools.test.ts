import { describe, expect, it } from "vitest";
import { OPENBOT_DYNAMIC_TOOLS } from "./openbot-tools";

describe("OpenBot hosting tools", () => {
  it("exposes the same hosting operations to Codex and Grok dynamic tools", () => {
    const names = OPENBOT_DYNAMIC_TOOLS.tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["list_sites", "publish_site", "replace_site", "delete_site"]));
  });

  it("requires site identity and local source details for mutations", () => {
    const publish = OPENBOT_DYNAMIC_TOOLS.tools.find((tool) => tool.name === "publish_site");
    const replace = OPENBOT_DYNAMIC_TOOLS.tools.find((tool) => tool.name === "replace_site");
    const remove = OPENBOT_DYNAMIC_TOOLS.tools.find((tool) => tool.name === "delete_site");
    expect(publish?.inputSchema).toMatchObject({ required: ["sourcePath", "title", "description"] });
    expect(replace?.inputSchema).toMatchObject({ required: ["siteId", "sourcePath", "title", "description"] });
    expect(remove?.inputSchema).toMatchObject({ required: ["siteId"] });
  });
});
