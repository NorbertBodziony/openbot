import { describe, expect, it } from "vitest";
import { OPENBOT_DYNAMIC_TOOLS } from "./openbot-tools";

describe("OpenBot hosting tools", () => {
  // OPENBOT_DYNAMIC_TOOLS is `as const` with no annotation, so the compiler
  // infers whatever the literal says instead of requiring these fields:
  // dropping one narrows the type and still typechecks, while the provider
  // would start omitting site identity or source metadata at runtime.
  it("requires site identity and local source details for mutations", () => {
    const publish = OPENBOT_DYNAMIC_TOOLS.tools.find((tool) => tool.name === "publish_site");
    const replace = OPENBOT_DYNAMIC_TOOLS.tools.find((tool) => tool.name === "replace_site");
    const remove = OPENBOT_DYNAMIC_TOOLS.tools.find((tool) => tool.name === "delete_site");
    expect(publish?.inputSchema).toMatchObject({ required: ["sourcePath", "title", "description"] });
    expect(replace?.inputSchema).toMatchObject({ required: ["siteId", "sourcePath", "title", "description"] });
    expect(remove?.inputSchema).toMatchObject({ required: ["siteId"] });
  });
});
