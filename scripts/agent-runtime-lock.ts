import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u, "Must use a complete SHA-256 value.");
const codexArtifactSchema = z.object({
  asset: z.string().min(1),
  assetSha256: sha256Schema,
  executable: z.string().regex(/^bin\/codex(?:\.exe)?$/u),
});
const claudeArtifactSchema = z.object({
  package: z.string().regex(/^@anthropic-ai\/claude-agent-sdk-(?:darwin-arm64|win32-x64)$/u),
  asset: z.string().regex(/^claude-agent-sdk-(?:darwin-arm64|win32-x64)-\d+\.\d+\.\d+\.tgz$/u),
  assetSha256: sha256Schema,
  binarySha256: sha256Schema,
  executable: z.enum(["claude", "claude.exe"]),
  platformDirectory: z.enum(["mac", "win"]),
});
const grokArtifactSchema = z.object({
  asset: z.string().regex(/^grok-\d+\.\d+\.\d+-(?:macos-aarch64|windows-x86_64(?:\.exe)?)$/u),
  assetSha256: sha256Schema,
  executable: z.enum(["grok", "grok.exe"]),
  platformDirectory: z.enum(["mac", "win"]),
});

const agentRuntimeLockSchema = z.object({
  schemaVersion: z.literal(1),
  codex: z.object({
    repository: z.literal("https://github.com/openai/codex"),
    version: z.string().regex(/^\d+\.\d+\.\d+$/u),
    tag: z.string().regex(/^rust-v\d+\.\d+\.\d+$/u),
    license: z.literal("Apache-2.0"),
    licenseSha256: sha256Schema,
    artifacts: z.object({
      "darwin-arm64": codexArtifactSchema,
      "win32-x64": codexArtifactSchema,
    }),
  }),
  claude: z.object({
    registry: z.literal("https://registry.npmjs.org"),
    sdkVersion: z.string().regex(/^\d+\.\d+\.\d+$/u),
    version: z.string().regex(/^\d+\.\d+\.\d+$/u),
    license: z.literal("Anthropic Legal Agreements"),
    licenseSha256: sha256Schema,
    artifacts: z.object({
      "darwin-arm64": claudeArtifactSchema,
      "win32-x64": claudeArtifactSchema,
    }),
  }),
  grok: z.object({
    repository: z.literal("https://github.com/xai-org/grok-build"),
    distribution: z.literal("https://x.ai/cli"),
    version: z.string().regex(/^\d+\.\d+\.\d+$/u),
    sourceCommit: z.string().regex(/^[0-9a-f]{40}$/u, "Must use a complete Git commit."),
    license: z.literal("Apache-2.0"),
    licenseSha256: sha256Schema,
    noticesSha256: sha256Schema,
    artifacts: z.object({
      "darwin-arm64": grokArtifactSchema,
      "win32-x64": grokArtifactSchema,
    }),
  }),
});

export type AgentRuntimeLock = z.infer<typeof agentRuntimeLockSchema>;

export async function loadAgentRuntimeLock(sourceRoot = process.cwd()): Promise<AgentRuntimeLock> {
  const path = resolve(sourceRoot, "native-runtime.lock.json");
  return parseAgentRuntimeLock(JSON.parse(await readFile(path, "utf8")));
}

export function parseAgentRuntimeLock(value: unknown): AgentRuntimeLock {
  return agentRuntimeLockSchema.parse(value);
}
