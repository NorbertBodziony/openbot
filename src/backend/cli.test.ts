// @vitest-environment node

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CodexCliError,
  parseClaudeVersion,
  parseCodexVersion,
  resolveClaudeCli,
  resolveCodexCli,
  windowsFallbackPaths,
} from "./cli";

const originalAppData = process.env.APPDATA;
const originalLocalAppData = process.env.LOCALAPPDATA;
const originalPath = process.env.PATH;
const temporaryPaths: string[] = [];

afterEach(async () => {
  restoreEnvironment("APPDATA", originalAppData);
  restoreEnvironment("LOCALAPPDATA", originalLocalAppData);
  restoreEnvironment("PATH", originalPath);
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("Codex CLI version parsing", () => {
  it("reads the installed CLI version format", () => {
    expect(parseCodexVersion("codex-cli 0.144.1\n")).toBe("0.144.1");
  });

  it("fails closed on an unknown format", () => {
    expect(() => parseCodexVersion("Codex development build")).toThrow(CodexCliError);
  });
});

describe("Claude CLI version parsing", () => {
  it("reads the installed CLI version format", () => {
    expect(parseClaudeVersion("2.1.231 (Claude Code)\n")).toBe("2.1.231");
  });

  it("fails closed on an unknown format", () => {
    expect(() => parseClaudeVersion("Claude development build")).toThrow(CodexCliError);
  });
});

describe("Windows CLI fallback paths", () => {
  it("includes current installer paths", () => {
    const environment = {
      APPDATA: "C:\\Users\\Jane Doe\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\Jane Doe\\AppData\\Local",
    };

    expect(windowsFallbackPaths("codex", "C:\\Users\\Jane Doe", environment)).toContain(
      "C:\\Users\\Jane Doe\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe",
    );
    expect(windowsFallbackPaths("claude", "C:\\Users\\Jane Doe", environment)).toEqual(
      expect.arrayContaining([
        "C:\\Users\\Jane Doe\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.exe",
        "C:\\Users\\Jane Doe\\.local\\bin\\claude.exe",
        "C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\claude.cmd",
      ]),
    );
  });

  it.runIf(process.platform === "win32")(
    "runs npm command shims when the user profile contains a space",
    async () => {
      const root = await createWindowsNpmShims();
      await expect(resolveCodexCli()).resolves.toMatchObject({ version: "0.144.1" });
      await expect(resolveClaudeCli()).resolves.toMatchObject({ version: "2.1.231" });
      expect(root).toContain("User Name");
    },
  );

  it.runIf(process.platform === "win32")("reports a CLI that exists but cannot start", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-cli-test-"));
    temporaryPaths.push(root);
    const appData = join(root, "User Name", "AppData", "Roaming");
    await mkdir(join(appData, "npm"), { recursive: true });
    await writeFile(join(appData, "npm", "codex.cmd"), "@echo off\r\nexit /b 1\r\n");
    useIsolatedWindowsEnvironment(appData, join(root, "missing-local-app-data"));

    await expect(resolveCodexCli()).rejects.toMatchObject({
      code: "invalid",
      message:
        "Codex CLI was found but could not be started. Run `codex --version` in a new terminal.",
    });
  });
});

async function createWindowsNpmShims(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openbot-cli-test-"));
  temporaryPaths.push(root);
  const appData = join(root, "User Name", "AppData", "Roaming");
  const npmDirectory = join(appData, "npm");
  await mkdir(npmDirectory, { recursive: true });
  await Promise.all([
    writeFile(join(npmDirectory, "codex.cmd"), "@echo off\r\necho codex-cli 0.144.1\r\n"),
    writeFile(join(npmDirectory, "claude.cmd"), "@echo off\r\necho 2.1.231 (Claude Code)\r\n"),
  ]);
  useIsolatedWindowsEnvironment(appData, join(root, "missing-local-app-data"));
  return root;
}

function useIsolatedWindowsEnvironment(appData: string, localAppData: string): void {
  process.env.APPDATA = appData;
  process.env.LOCALAPPDATA = localAppData;
  process.env.PATH = "";
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
