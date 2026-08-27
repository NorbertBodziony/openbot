// @vitest-environment node

import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bundledClaudeExecutable,
  bundledCodexExecutable,
  bundledGrokExecutable,
  CodexCliError,
  parseClaudeVersion,
  parseCodexVersion,
  parseGrokVersion,
  posixFallbackPaths,
  resolveClaudeCli,
  resolveCodexCli,
  resolveGrokCli,
  windowsFallbackPaths,
} from "./cli";

const originalAppData = process.env.APPDATA;
const originalLocalAppData = process.env.LOCALAPPDATA;
const originalPath = process.env.PATH;
const originalGrokPath = process.env.OPENBOT_GROK_PATH;
const temporaryPaths: string[] = [];

afterEach(async () => {
  restoreEnvironment("APPDATA", originalAppData);
  restoreEnvironment("LOCALAPPDATA", originalLocalAppData);
  restoreEnvironment("PATH", originalPath);
  restoreEnvironment("OPENBOT_GROK_PATH", originalGrokPath);
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

describe("bundled Codex resolution", () => {
  it("resolves the packaged runtime path for supported targets", () => {
    expect(bundledCodexExecutable("darwin", "arm64", "/Applications/OpenBot.app/Contents/Resources")).toBe(
      "/Applications/OpenBot.app/Contents/Resources/codex/mac/arm64/bin/codex",
    );
    expect(bundledCodexExecutable("win32", "x64", "C:\\Program Files\\OpenBot\\resources")).toBe(
      "C:\\Program Files\\OpenBot\\resources\\codex\\win\\x64\\bin\\codex.exe",
    );
    expect(bundledCodexExecutable("linux", "x64", "/resources")).toBeNull();
  });

  it("resolves the build runtime path during development", () => {
    expect(bundledCodexExecutable("darwin", "arm64", null)).toBe(
      join(process.cwd(), "build/codex/mac/arm64/bin/codex"),
    );
    expect(bundledCodexExecutable("darwin", "arm64", undefined)).toBe(
      join(process.cwd(), "build/codex/mac/arm64/bin/codex"),
    );
  });

  it.runIf(process.platform !== "win32")("prefers a compatible system CLI", async () => {
    const system = await createExecutable("system-codex", "codex-cli 0.148.0");
    const bundled = await createExecutable("bundled-codex", "codex-cli 0.149.1");

    await expect(resolveCodexCli({ systemCandidates: [system], bundledExecutable: bundled })).resolves.toEqual({
      executable: system,
      version: "0.148.0",
      source: "system",
    });
  });

  it.runIf(process.platform !== "win32")("falls back when the system CLI is outdated or invalid", async () => {
    const outdated = await createExecutable("old-codex", "codex-cli 0.120.0");
    const invalid = await createExecutable("broken-codex", "not a version");
    const bundled = await createExecutable("bundled-codex", "codex-cli 0.149.1");

    await expect(
      resolveCodexCli({ systemCandidates: [outdated, invalid], bundledExecutable: bundled }),
    ).resolves.toEqual({
      executable: bundled,
      version: "0.149.1",
      source: "managed",
    });
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

describe("bundled Claude resolution", () => {
  it("resolves the packaged runtime path for supported targets", () => {
    expect(bundledClaudeExecutable("darwin", "arm64", "/Applications/OpenBot.app/Contents/Resources")).toBe(
      "/Applications/OpenBot.app/Contents/Resources/claude/mac/arm64/bin/claude",
    );
    expect(bundledClaudeExecutable("win32", "x64", "C:\\Program Files\\OpenBot\\resources")).toBe(
      "C:\\Program Files\\OpenBot\\resources\\claude\\win\\x64\\bin\\claude.exe",
    );
    expect(bundledClaudeExecutable("linux", "x64", "/resources")).toBeNull();
  });

  it.runIf(process.platform !== "win32")("prefers a compatible system CLI", async () => {
    const system = await createExecutable("system-claude", "2.1.240 (Claude Code)");
    const bundled = await createExecutable("bundled-claude", "2.1.246 (Claude Code)");

    await expect(resolveClaudeCli({ systemCandidates: [system], bundledExecutable: bundled })).resolves.toEqual({
      executable: system,
      version: "2.1.240",
      source: "system",
    });
  });

  it.runIf(process.platform !== "win32")("falls back when the system CLI is outdated or invalid", async () => {
    const outdated = await createExecutable("old-claude", "2.0.0 (Claude Code)");
    const invalid = await createExecutable("broken-claude", "not a version");
    const bundled = await createExecutable("bundled-claude", "2.1.246 (Claude Code)");

    await expect(
      resolveClaudeCli({ systemCandidates: [outdated, invalid], bundledExecutable: bundled }),
    ).resolves.toEqual({
      executable: bundled,
      version: "2.1.246",
      source: "managed",
    });
  });
});

describe("bundled Grok CLI resolution", () => {
  it("reads Grok versions and includes documented macOS and Windows locations", () => {
    expect(parseGrokVersion("grok 1.0.5\n")).toBe("1.0.5");
    expect(posixFallbackPaths("grok", "/Users/jane")).toContain("/Users/jane/.grok/bin/grok");
    expect(
      windowsFallbackPaths("grok", "C:\\Users\\Jane", {
        LOCALAPPDATA: "C:\\Users\\Jane\\AppData\\Local",
      }),
    ).toEqual(
      expect.arrayContaining([
        "C:\\Users\\Jane\\.grok\\bin\\grok.exe",
        "C:\\Users\\Jane\\AppData\\Local\\Microsoft\\WinGet\\Links\\grok.exe",
      ]),
    );
  });

  it("resolves the packaged runtime path for supported targets", () => {
    expect(bundledGrokExecutable("darwin", "arm64", "/Applications/OpenBot.app/Contents/Resources")).toBe(
      "/Applications/OpenBot.app/Contents/Resources/grok/mac/arm64/bin/grok",
    );
    expect(bundledGrokExecutable("win32", "x64", "C:\\Program Files\\OpenBot\\resources")).toBe(
      "C:\\Program Files\\OpenBot\\resources\\grok\\win\\x64\\bin\\grok.exe",
    );
    expect(bundledGrokExecutable("linux", "x64", "/resources")).toBeNull();
  });

  it.runIf(process.platform !== "win32")("honors OPENBOT_GROK_PATH and probes --version", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-grok-cli-test-"));
    temporaryPaths.push(root);
    const executable = join(root, "grok");
    await writeFile(executable, "#!/bin/sh\nprintf 'grok 1.0.5\\n'\n");
    await chmod(executable, 0o700);
    process.env.OPENBOT_GROK_PATH = executable;

    await expect(resolveGrokCli({ bundledExecutable: null })).resolves.toEqual({
      executable,
      version: "1.0.5",
      source: "system",
    });
  });

  it("does not fabricate an installed Grok CLI when the configured executable is missing", async () => {
    process.env.OPENBOT_GROK_PATH = join(tmpdir(), `missing-grok-${Date.now()}`);
    await expect(resolveGrokCli({ bundledExecutable: null })).rejects.toMatchObject({ code: "missing" });
  });

  it.runIf(process.platform !== "win32")("falls back when the system CLI is outdated or invalid", async () => {
    const outdated = await createExecutable("old-grok", "grok 0.9.0");
    const invalid = await createExecutable("broken-grok", "not a version");
    const bundled = await createExecutable("bundled-grok", "grok 1.0.5");

    await expect(
      resolveGrokCli({ systemCandidates: [outdated, invalid], bundledExecutable: bundled }),
    ).resolves.toEqual({
      executable: bundled,
      version: "1.0.5",
      source: "managed",
    });
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

  it.runIf(process.platform === "win32")("runs npm command shims when the user profile contains a space", async () => {
    await createWindowsNpmShims();
    await expect(resolveCodexCli()).resolves.toMatchObject({ version: "0.144.1" });
    await expect(resolveClaudeCli()).resolves.toMatchObject({ version: "2.1.232", source: "system" });
  });

  it.runIf(process.platform === "win32")("reports a CLI that exists but cannot start", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-cli-test-"));
    temporaryPaths.push(root);
    const appData = join(root, "User Name", "AppData", "Roaming");
    await mkdir(join(appData, "npm"), { recursive: true });
    await writeFile(join(appData, "npm", "codex.cmd"), "@echo off\r\nexit /b 1\r\n");
    useIsolatedWindowsEnvironment(appData, join(root, "missing-local-app-data"));

    await expect(resolveCodexCli()).rejects.toMatchObject({
      code: "invalid",
      message: "Codex CLI was found but could not be started. Run `codex --version` in a new terminal.",
    });
  });
});

async function createWindowsNpmShims(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "openbot-cli-test-"));
  temporaryPaths.push(root);
  const appData = join(root, "User Name", "AppData", "Roaming");
  const npmDirectory = join(appData, "npm");
  await mkdir(npmDirectory, { recursive: true });
  await Promise.all([
    writeFile(join(npmDirectory, "codex.cmd"), "@echo off\r\necho codex-cli 0.144.1\r\n"),
    writeFile(join(npmDirectory, "claude.cmd"), "@echo off\r\necho 2.1.232 (Claude Code)\r\n"),
  ]);
  useIsolatedWindowsEnvironment(appData, join(root, "missing-local-app-data"));
}

async function createExecutable(name: string, versionOutput: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openbot-cli-test-"));
  temporaryPaths.push(root);
  const path = join(root, name);
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' '${versionOutput}'\n`);
  await chmod(path, 0o755);
  return path;
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
