import { TEAM_PROTOCOL_V3_CAPABILITIES } from "./v3";

export const TEAM_SEMANTIC_TAGS_CAPABILITY = "installed-skills";
export const TEAM_AGENT_ACTIVITY_CAPABILITY = "agent-activity";
export const TEAM_MODEL_SCOPED_USAGE_CAPABILITY = "model-scoped-usage";

export const TEAM_CURRENT_CAPABILITIES = [
  ...TEAM_PROTOCOL_V3_CAPABILITIES,
  TEAM_SEMANTIC_TAGS_CAPABILITY,
  TEAM_AGENT_ACTIVITY_CAPABILITY,
  TEAM_MODEL_SCOPED_USAGE_CAPABILITY,
] as const;

export type TeamCurrentCapability = (typeof TEAM_CURRENT_CAPABILITIES)[number];

const TEAM_CURRENT_CAPABILITY_SET = new Set<string>(TEAM_CURRENT_CAPABILITIES);

export function isTeamCurrentCapability(value: string): value is TeamCurrentCapability {
  return TEAM_CURRENT_CAPABILITY_SET.has(value);
}

export function supportsTeamSemanticTags(capabilities: readonly string[] | ReadonlySet<string>): boolean {
  return [...capabilities].includes(TEAM_SEMANTIC_TAGS_CAPABILITY);
}
