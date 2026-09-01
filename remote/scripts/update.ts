import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const compose = ["compose", "-f", "remote/compose.yaml"];

await run("docker", [...compose, "build", "remote-api", "coturn"], root);
await run("docker", [...compose, "up", "-d", "--no-build", "--no-deps", "remote-api"], root);

const coturnExists = (await capture("docker", ["inspect", "openbot-coturn"], root)).code === 0;
if (coturnExists) {
  console.log("Draining coturn. The update waits until all relay allocations end.");
  await run("docker", ["update", "--restart=no", "openbot-coturn"], root);
  await run("docker", ["kill", "--signal=SIGUSR1", "openbot-coturn"], root);
  await run("docker", ["wait", "openbot-coturn"], root);
}
await run("docker", [...compose, "up", "-d", "--no-build", "--no-deps", "--force-recreate", "coturn"], root);
await run("docker", [...compose, "ps"], root);

async function run(command: string, args: string[], cwd: string): Promise<void> {
  const result = await execute(command, args, cwd, "inherit");
  if (result !== 0) throw new Error(`${command} failed with exit code ${result}.`);
}

async function capture(command: string, args: string[], cwd: string): Promise<{ code: number }> {
  return { code: await execute(command, args, cwd, "ignore") };
}

function execute(command: string, args: string[], cwd: string, stdio: "inherit" | "ignore"): Promise<number> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(command, args, { cwd, stdio, shell: false });
    child.once("error", reject);
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
}
