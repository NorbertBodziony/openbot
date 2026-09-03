import { realpath, stat } from "node:fs/promises";
import { basename } from "node:path";
import { isWithin, sharedPathFromInput, workspacePathFromInput } from "../workspace-paths";

export interface ResolvedWorkspaceFile {
  path: string;
  name: string;
  size: number;
}

export async function resolveSharedFilePath(sharedRoot: string, inputPath: string): Promise<ResolvedWorkspaceFile> {
  const root = await realpath(sharedRoot);
  const candidatePath = sharedPathFromInput(sharedRoot, inputPath);
  const resolvedPath = await realpath(candidatePath);
  if (!isWithin(root, resolvedPath)) {
    throw new Error("Shared file must be inside the shared directory.");
  }
  const metadata = await stat(resolvedPath);
  if (!metadata.isFile()) throw new Error("Shared path is not a file.");
  return { path: resolvedPath, name: basename(resolvedPath), size: metadata.size };
}

export async function resolveWorkspaceFilePath(
  workspaceRoot: string,
  botId: string,
  inputPath: string,
): Promise<ResolvedWorkspaceFile> {
  const root = await realpath(workspaceRoot);
  const candidatePath = workspacePathFromInput(workspaceRoot, botId, inputPath);
  const resolvedPath = await realpath(candidatePath);
  if (!isWithin(root, resolvedPath)) {
    throw new Error("Workspace file must be inside the agent workspace.");
  }
  const metadata = await stat(resolvedPath);
  if (!metadata.isFile()) throw new Error("Workspace path is not a file.");
  return { path: resolvedPath, name: basename(resolvedPath), size: metadata.size };
}
