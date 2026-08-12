import { CodexAppServerClient } from "../src/backend/app-server-client";
import { resolveCodexCli } from "../src/backend/cli";
import { type AccountReadResult, getArray, getString, isRecord } from "../src/backend/protocol";

const strict = process.argv.includes("--strict");
let client: CodexAppServerClient | null = null;

try {
  const cli = await resolveCodexCli();
  client = new CodexAppServerClient(cli.executable, 10_000);
  client.start();
  await client.request("initialize", {
    clientInfo: { name: "openbot_doctor", title: "Openbot Doctor", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  });
  client.notify("initialized");

  const account = await client.request<AccountReadResult>("account/read", { refreshToken: false });
  const plugins = await client.request<unknown>("plugin/list", { cwds: [] });
  const computerUse = findComputerUse(plugins);
  const auth = account.account
    ? {
        type: account.account.type,
        planType: account.account.type === "chatgpt" ? (account.account.planType ?? null) : null,
      }
    : null;

  console.log(
    JSON.stringify(
      {
        ok: account.account?.type === "chatgpt",
        executable: cli.executable,
        cliVersion: cli.version,
        appServer: "ready",
        auth,
        computerUse,
      },
      null,
      2,
    ),
  );

  if (strict && account.account?.type !== "chatgpt") process.exitCode = 1;
} catch (error) {
  console.error(
    JSON.stringify(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  if (client) await client.stop();
}

function findComputerUse(value: unknown): "installed" | "missing" {
  for (const marketplace of getArray(value, "marketplaces")) {
    for (const plugin of getArray(marketplace, "plugins")) {
      if (!isRecord(plugin)) continue;
      const id = getString(plugin, "id");
      const name = getString(plugin, "name");
      if (
        (id === "computer-use@openai-bundled" || name === "computer-use") &&
        plugin.installed === true &&
        plugin.enabled === true
      ) {
        return "installed";
      }
    }
  }
  return "missing";
}
