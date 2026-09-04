import { basename, dirname, isAbsolute, join, relative } from "node:path";

export function sharedPathFromInput(sharedRoot: string, inputPath: string): string {
  const normalized = inputPath.replaceAll("\\", "/");
  for (const prefix of ["~/OpenBot/Shared/", "OpenBot/Shared/", "Shared/"]) {
    if (normalized.startsWith(prefix)) return join(sharedRoot, normalized.slice(prefix.length));
  }
  return isAbsolute(inputPath) ? inputPath : join(sharedRoot, normalized);
}

/**
 * The two `Bots` prefixes are permanent. This function reads paths the model writes and paths quoted in
 * messages, and the workspace root was `~/OpenBot/Bots/bot-<uuid>` in every release before the
 * bot-to-agent rename. A database restored from the user's own copy of the file never ran migration v13,
 * so it still spells both the id and the path that way; and a cross-device root legitimately leaves a
 * workspace under the old name even after v13. Dropping the prefix does not fail loudly -- the path just
 * resolves somewhere else.
 */
export function workspacePathFromInput(workspaceRoot: string, agentId: string, inputPath: string): string {
  const decoded = decodePath(inputPath.trim());
  const normalized = decoded.replaceAll("\\", "/");
  const legacyId = agentId.startsWith("agent-") ? `bot-${agentId.slice("agent-".length)}` : agentId;
  for (const prefix of [
    `~/OpenBot/Agents/${agentId}/`,
    `OpenBot/Agents/${agentId}/`,
    `~/OpenBot/Bots/${legacyId}/`,
    `OpenBot/Bots/${legacyId}/`,
  ]) {
    if (normalized.startsWith(prefix)) return join(workspaceRoot, normalized.slice(prefix.length));
  }
  return isAbsolute(decoded) ? decoded : join(workspaceRoot, normalized);
}

/** The directory name a pre-rename build gave this agent. An id it did not mint is unchanged. */
export function legacyAgentId(agentId: string): string {
  return agentId.startsWith("agent-") ? `bot-${agentId.slice("agent-".length)}` : agentId;
}

/**
 * An absolute path under this agent's pre-rename workspace root, rebased onto its current one, or `null`
 * if it is not one. The provider keeps its own transcript behind `external_session_id`, and migration v13
 * cannot reach into it, so a resumed thread can still hand back a path it wrote before the workspace
 * moved. Callers try this only after the original path is gone, and put the result through the same
 * {@link isWithin} containment check as any other candidate -- the fallback finds the file again, it does
 * not open a second way out of the workspace.
 */
export function rebaseLegacyWorkspacePath(workspacePath: string, agentId: string, candidate: string): string | null {
  if (basename(workspacePath) !== agentId || basename(dirname(workspacePath)) !== "Agents") return null;
  const legacyRoot = join(dirname(dirname(workspacePath)), "Bots", legacyAgentId(agentId));
  if (legacyRoot === workspacePath || !isWithin(legacyRoot, candidate)) return null;
  return join(workspacePath, relative(legacyRoot, candidate));
}

export function isWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
