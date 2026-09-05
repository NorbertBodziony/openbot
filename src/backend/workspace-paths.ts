import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { isUuidV4 } from "@openbot/contracts/validation";

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
  const legacyId = legacyAgentId(agentId);
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

/**
 * The directory name a pre-rename build gave this agent, or the id unchanged when no pre-rename build could
 * have minted it.
 *
 * The UUID suffix is what makes this reversible, and it is the whole safety argument. Only the app mints
 * `agent-<uuid>`, so only such an id is guaranteed to have been `bot-<uuid>` before migration v13. An id a
 * user or an imported `bots.json` chose is an ordinary word: `agent-research` translated to `bot-research`
 * names a directory that may well belong to a *different* agent, and callers here delete directories
 * recursively.
 */
export function legacyAgentId(agentId: string): string {
  if (!agentId.startsWith("agent-") || !isGeneratedAgentId(agentId)) return agentId;
  return `bot-${agentId.slice("agent-".length)}`;
}

/** Whether this id is one the app minted for itself, in either the pre- or post-rename spelling. */
export function isGeneratedAgentId(agentId: string): boolean {
  const prefix = agentId.startsWith("agent-") ? "agent-" : agentId.startsWith("bot-") ? "bot-" : null;
  return prefix !== null && isUuidV4(agentId.slice(prefix.length));
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
