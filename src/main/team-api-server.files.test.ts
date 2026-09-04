// @vitest-environment node

// Attachments, shared files and workspace files: `src/main/team-api/route-files.ts`.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ATTACHMENT_LIMITS } from "@openbot/contracts/input-limits";
import { afterEach, describe, expect, it } from "vitest";
import { createAgents, createTeamApiFixture, stopTeamApiFixtures } from "./team-api-server-test-harness";

afterEach(stopTeamApiFixtures);

describe("TeamApiServer files", () => {
  it("downloads authenticated shared files through the remote API", async () => {
    const { root, start, signIn } = await createTeamApiFixture("shared-file", { configure: true });
    const filePath = join(root, "report.csv");
    await writeFile(filePath, "name,value\nOpenBot,1\n");
    const agents = createAgents({
      resolveSharedFile: async (path) => ({
        path: filePath,
        name: path.includes("large") ? "large.csv" : "report.csv",
        size: path.includes("large") ? ATTACHMENT_LIMITS.fileBytes + 1 : 21,
      }),
      resolveWorkspaceFile: async (botId, path) => ({
        path: filePath,
        name: `${botId}-${path.split("/").at(-1)}`,
        size: 21,
      }),
    });
    const { base } = await start({ agents });

    const token = await signIn();
    const response = await fetch(`${base}/v1/shared-files?path=${encodeURIComponent("~/OpenBot/Shared/report.csv")}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("report.csv");
    expect(await response.text()).toBe("name,value\nOpenBot,1\n");

    const oversized = await fetch(`${base}/v1/shared-files?path=${encodeURIComponent("~/OpenBot/Shared/large.csv")}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(oversized.status).toBe(413);

    const unauthorized = await fetch(`${base}/v1/shared-files?path=Shared/report.csv`);
    expect(unauthorized.status).toBe(401);

    const workspaceResponse = await fetch(
      `${base}/v1/workspace-files?botId=chief&path=${encodeURIComponent("app/page.tsx")}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    expect(workspaceResponse.status).toBe(200);
    expect(workspaceResponse.headers.get("content-disposition")).toContain("chief-page.tsx");
    expect(await workspaceResponse.text()).toBe("name,value\nOpenBot,1\n");

    const unauthorizedWorkspace = await fetch(`${base}/v1/workspace-files?botId=chief&path=app/page.tsx`);
    expect(unauthorizedWorkspace.status).toBe(401);
  });
});
