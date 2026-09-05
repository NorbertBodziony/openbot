import type { AttachmentSummary, MessageReaction } from "@openbot/contracts/ipc";
import { LANDING_PREVIEW_ATTACHMENTS } from "./landing-fixtures";

const LANDING_EVIDENCE_MAP: AttachmentSummary = {
  id: "landing-evidence-map",
  name: "evidence-map.md",
  size: 3_072,
  kind: "file",
  mimeType: "text/markdown",
  previewKind: "text",
  previewUrl: null,
};

const LANDING_ROLLOUT_CHECKLIST: AttachmentSummary = {
  id: "landing-rollout-checklist",
  name: "rollout-checklist.md",
  size: 2_560,
  kind: "file",
  mimeType: "text/markdown",
  previewKind: "text",
  previewUrl: null,
};

const LANDING_RELEASE_NOTE: AttachmentSummary = {
  id: "landing-release-note",
  name: "release-note.md",
  size: 1_792,
  kind: "file",
  mimeType: "text/markdown",
  previewKind: "text",
  previewUrl: null,
};

export const LANDING_SCRIPT_MESSAGE_PREFIX = "landing-script:";
export const LANDING_DIRECT_SCRIPT_MESSAGE_PREFIX = "landing-direct-script:";

export interface LandingDemoScript {
  agentId: string;
  prompt: string;
  thinkingSteps: [string, string];
  response: string;
  attachments: AttachmentSummary[];
  reaction: MessageReaction | null;
  recipientAgentIds: string[];
}

export const LANDING_DEMO_SCRIPTS: Record<string, LandingDemoScript> = {
  chief: {
    agentId: "chief",
    prompt:
      "Turn this into the final launch brief. Use @Research's evidence, @Builder's rollout notes, and attach the source files.",
    thinkingSteps: [
      "Reading launch-brief.md and launch-metrics.csv.",
      "Checking owners with @Research and @Builder, then preparing the release handoff.",
    ],
    response: [
      "## Final launch brief",
      "",
      "I merged @Research's evidence with @Builder's rollout notes.",
      "",
      "| Workstream | Owner | Status |",
      "| --- | --- | --- |",
      "| Evidence | @Research | 7 of 8 claims verified |",
      "| Rollout | @Builder | Ready with rollback |",
      "| Release | @Launch | Ready after final claim |",
      "",
      "Source files: launch-brief.md and launch-metrics.csv. @Launch can publish when the final claim is confirmed.",
    ].join("\n"),
    attachments: LANDING_PREVIEW_ATTACHMENTS,
    reaction: "✅",
    recipientAgentIds: ["launch"],
  },
  research: {
    agentId: "research",
    prompt: "Verify the claims in launch-brief.md against launch-metrics.csv. Flag anything that still needs a source.",
    thinkingSteps: [
      "Mapping each launch claim to the source files.",
      "Checking the remaining unsupported claim before reporting to @Chief.",
    ],
    response: [
      "## Evidence check",
      "",
      "| Claim | Evidence | Decision |",
      "| --- | --- | --- |",
      "| Faster setup | launch-metrics.csv | Verified |",
      "| Persistent context | launch-brief.md | Verified |",
      "| 40% less review time | No primary source | Needs source |",
      "",
      "Seven of eight claims are verified. I documented the gap in evidence-map.md and tagged @Chief for the final wording decision.",
    ].join("\n"),
    attachments: [...LANDING_PREVIEW_ATTACHMENTS, LANDING_EVIDENCE_MAP],
    reaction: null,
    recipientAgentIds: ["chief"],
  },
  builder: {
    agentId: "builder",
    prompt: "Turn @Research's findings into a release checklist with rollback steps.",
    thinkingSteps: [
      "Reading evidence-map.md and grouping the release gates.",
      "Checking the rollback command before notifying @Launch.",
    ],
    response: [
      "## Rollout checklist",
      "",
      "| Gate | Owner | Status |",
      "| --- | --- | --- |",
      "| Product QA | @Builder | Ready |",
      "| Claim review | @Research | One source needed |",
      "| Rollback owner | @Launch | Assigned |",
      "",
      "```bash",
      "bun run check && bun run release:rollback --dry-run",
      "```",
      "",
      "The full checklist is in rollout-checklist.md. @Launch can use it for the release window.",
    ].join("\n"),
    attachments: [LANDING_EVIDENCE_MAP, LANDING_ROLLOUT_CHECKLIST],
    reaction: null,
    recipientAgentIds: ["launch"],
  },
  launch: {
    agentId: "launch",
    prompt: "Package the final release note and hand it back to @Chief.",
    thinkingSteps: [
      "Combining the verified claims with the rollout checklist.",
      "Preparing the final release note and handoff to @Chief.",
    ],
    response: [
      "## Release package",
      "",
      "The final release note is ready in release-note.md.",
      "",
      "| Asset | Status |",
      "| --- | --- |",
      "| Product copy | Approved |",
      "| Evidence note | Included |",
      "| Rollback steps | Included |",
      "",
      "@Chief has the complete package for final approval.",
    ].join("\n"),
    attachments: [LANDING_RELEASE_NOTE],
    reaction: "🚀",
    recipientAgentIds: ["chief"],
  },
};

export interface LandingDirectDemoScript {
  memberId: string;
  question: string;
  answer: string;
  followUp: string;
  finalAnswer: string;
}

export const LANDING_DIRECT_DEMO_SCRIPTS: Record<string, LandingDirectDemoScript> = {
  "member-alice": {
    memberId: "member-alice",
    question: "Before we publish, can you give me the exact copy decision and what changed?",
    answer:
      "I kept the verified setup metric, removed the 40% review-time claim, and added a clear evidence note. The release copy now matches Research's findings.",
    followUp: "Is there anything that Launch still needs from us?",
    finalAnswer:
      "Only final approval. The approved copy, evidence caveat, and source links are in release-note.md. I also sent the complete handoff to Launch.",
  },
  "member-maya": {
    memberId: "member-maya",
    question: "Can you confirm the exact support plan, owners, and escalation path for the release window?",
    answer:
      "I cover the first two hours. The EU team takes over at 14:00 UTC. Critical product issues go to Builder, and copy questions go to Launch.",
    followUp: "What should the handoff checklist include?",
    finalAnswer:
      "Add the on-call owners, dashboard links, rollback contact, and the open analytics alert. I will post a short status update at each handoff.",
  },
  "member-jon": {
    memberId: "member-jon",
    question: "Can you summarize the rollback drill and the remaining risk before we launch?",
    answer:
      "Staging rolled back in four minutes. Data stayed intact, and every worker recovered. The only remaining risk is a delayed analytics alert.",
    followUp: "Does that block the launch, or does it only need an owner?",
    finalAnswer:
      "It does not block the launch. Builder owns the alert threshold, and I will watch the dashboard during the first hour and escalate any delay.",
  },
};
