import type {
  AttachmentSummary,
  BotSummary,
  ConversationMessage,
  ConversationSnapshot,
  DirectConversationSnapshot,
  DirectThreadSummary,
  MessageReaction,
  ServerSummary,
} from "@openbot/contracts/ipc";
import developmentLogoUrl from "../assets/openbot-logo-dev.png";
import productionLogoUrl from "../assets/openbot-logo-production.png";
import type { MockOpenBotOptions } from "./mock-openbot";

const LANDING_PREVIEW_NOW = "2026-08-21T10:00:00.000Z";

const LANDING_PREVIEW_BOTS: BotSummary[] = [
  {
    id: "chief",
    name: "Chief",
    title: "Chief of staff",
    description: "Coordinates priorities, decisions, and handoffs across the team.",
    notifications: true,
    model: "gpt-5.6-luna",
    reasoningEffort: "low",
    threadId: "thread-chief",
    workspacePath: "/mock/OpenBot/Bots/chief",
    preview: "The launch plan is ready with owners, evidence, and next actions.",
    updatedAt: LANDING_PREVIEW_NOW,
    avatarSeed: "chief",
    avatarHue: 245,
    avatarUrl: null,
  },
  {
    id: "research",
    name: "Research",
    title: "Research partner",
    description: "Finds reliable sources and turns them into concise briefs.",
    notifications: true,
    model: "gpt-5.6-luna",
    reasoningEffort: "low",
    threadId: "thread-research",
    workspacePath: "/mock/OpenBot/Bots/research",
    preview: "The source review and evidence map are complete.",
    updatedAt: "2026-08-21T09:48:00.000Z",
    avatarSeed: "research",
    avatarHue: 185,
    avatarUrl: null,
  },
  {
    id: "builder",
    name: "Builder",
    title: "Product engineer",
    description: "Builds product changes and records clear technical decisions.",
    notifications: true,
    model: "gpt-5.6-luna",
    reasoningEffort: "low",
    threadId: "thread-builder",
    workspacePath: "/mock/OpenBot/Bots/builder",
    preview: "The implementation checklist includes tests and rollback steps.",
    updatedAt: "2026-08-21T09:36:00.000Z",
    avatarSeed: "builder",
    avatarHue: 30,
    avatarUrl: null,
  },
  {
    id: "launch",
    name: "Launch",
    title: "Go-to-market lead",
    description: "Prepares launch assets, messaging, and release checklists.",
    notifications: true,
    model: "gpt-5.6-luna",
    reasoningEffort: "low",
    threadId: "thread-launch",
    workspacePath: "/mock/OpenBot/Bots/launch",
    preview: "The launch brief is ready for final review.",
    updatedAt: "2026-08-21T09:24:00.000Z",
    avatarSeed: "launch",
    avatarHue: 320,
    avatarUrl: null,
  },
];

const LANDING_PREVIEW_ATTACHMENTS: AttachmentSummary[] = [
  {
    id: "landing-launch-brief",
    name: "launch-brief.md",
    size: 2_048,
    kind: "file",
    mimeType: "text/markdown",
    previewKind: "text",
    previewUrl: null,
  },
  {
    id: "landing-launch-metrics",
    name: "launch-metrics.csv",
    size: 1_024,
    kind: "file",
    mimeType: "text/csv",
    previewKind: "text",
    previewUrl: null,
  },
];

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
  botId: string;
  prompt: string;
  thinkingSteps: [string, string];
  response: string;
  attachments: AttachmentSummary[];
  reaction: MessageReaction | null;
  recipientBotIds: string[];
}

export const LANDING_DEMO_SCRIPTS: Record<string, LandingDemoScript> = {
  chief: {
    botId: "chief",
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
    recipientBotIds: ["launch"],
  },
  research: {
    botId: "research",
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
    recipientBotIds: ["chief"],
  },
  builder: {
    botId: "builder",
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
    recipientBotIds: ["launch"],
  },
  launch: {
    botId: "launch",
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
    recipientBotIds: ["chief"],
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

const LANDING_PREVIEW_CHIEF_MESSAGES: ConversationMessage[] = [
  {
    id: "landing-chief-request",
    author: "user",
    source: "user",
    text: "Prepare the launch plan, tag @Research, and keep every decision traceable.",
    createdAt: "2026-08-21T09:42:00.000Z",
    status: "completed",
  },
  {
    id: "landing-chief-plan",
    author: "assistant",
    source: "assistant",
    text: [
      "## Launch plan",
      "",
      "I asked @Research to verify the evidence and @Builder to check the rollout path.",
      "",
      "| Workstream | Owner | Status |",
      "| --- | --- | --- |",
      "| Product QA | @Builder | Ready |",
      "| Evidence | @Research | In review |",
      "| Release | @Launch | Ready |",
      "",
      "Next: confirm the rollback owner, then publish the release note.",
    ].join("\n"),
    createdAt: "2026-08-21T09:43:00.000Z",
    status: "completed",
    attachments: LANDING_PREVIEW_ATTACHMENTS,
    reaction: "\u2705",
  },
  {
    id: "landing-chief-exchange",
    author: "system",
    source: "system",
    text: "",
    createdAt: "2026-08-21T09:44:00.000Z",
    status: "completed",
    exchange: {
      direction: "outgoing",
      messageId: "landing-chief-exchange",
      senderBotId: "chief",
      recipientBotIds: ["research", "builder"],
      replyToMessageId: "landing-chief-plan",
      deliveries: [
        {
          id: "landing-delivery-research",
          recipientBotId: "research",
          status: "completed",
          position: null,
          error: null,
        },
        {
          id: "landing-delivery-builder",
          recipientBotId: "builder",
          status: "completed",
          position: null,
          error: null,
        },
      ],
    },
  },
  {
    id: "landing-chief-ready",
    author: "assistant",
    source: "assistant",
    text: "Research verified seven of eight claims. Builder added the test and rollback steps. The final review is ready.",
    createdAt: "2026-08-21T09:45:00.000Z",
    status: "completed",
  },
];

const LANDING_PREVIEW_SNAPSHOTS: Record<string, ConversationSnapshot> = Object.fromEntries(
  LANDING_PREVIEW_BOTS.map((bot) => [
    bot.id,
    {
      botId: bot.id,
      threadId: bot.threadId,
      activeTurnId: null,
      revision: 1,
      messages: bot.id === "chief" ? LANDING_PREVIEW_CHIEF_MESSAGES : [],
    },
  ]),
);

const LANDING_PREVIEW_SERVERS: ServerSummary[] = [
  {
    id: "local",
    name: "Local",
    logoUrl: developmentLogoUrl,
    kind: "local",
    state: "online",
    apiUrl: null,
    remoteDesktopAvailable: false,
    role: null,
    active: false,
  },
  {
    id: "team",
    name: "OpenBot team",
    logoUrl: productionLogoUrl,
    kind: "remote",
    state: "online",
    apiUrl: "https://team.example.com",
    remoteDesktopAvailable: true,
    role: "owner",
    active: true,
  },
];

const LANDING_PREVIEW_DIRECT_SNAPSHOTS: Record<string, DirectConversationSnapshot> = {
  "member-alice": {
    threadId: "direct-alice",
    otherMemberId: "member-alice",
    revision: 1,
    readState: {
      unreadCount: 1,
      firstUnreadMessageId: "landing-direct-alice-3",
      throughSequence: 2,
    },
    messages: [
      {
        id: "landing-direct-alice-1",
        threadId: "direct-alice",
        senderMemberId: "member-alice",
        recipientMemberId: "member-self",
        text: "I tightened the launch note and removed the unsupported review-time claim.",
        createdAt: "2026-08-21T09:47:00.000Z",
        sequence: 1,
      },
      {
        id: "landing-direct-alice-2",
        threadId: "direct-alice",
        senderMemberId: "member-self",
        recipientMemberId: "member-alice",
        text: "Perfect. Please keep the verified setup metric and send the final copy to Launch.",
        createdAt: "2026-08-21T09:49:00.000Z",
        sequence: 2,
      },
      {
        id: "landing-direct-alice-3",
        threadId: "direct-alice",
        senderMemberId: "member-alice",
        recipientMemberId: "member-self",
        text: "Done — the final wording is in release-note.md and Launch has the handoff.",
        createdAt: "2026-08-21T09:52:00.000Z",
        sequence: 3,
      },
    ],
  },
  "member-maya": {
    threadId: "direct-maya",
    otherMemberId: "member-maya",
    revision: 1,
    readState: {
      unreadCount: 0,
      firstUnreadMessageId: null,
      throughSequence: 3,
    },
    messages: [
      {
        id: "landing-direct-maya-1",
        threadId: "direct-maya",
        senderMemberId: "member-self",
        recipientMemberId: "member-maya",
        text: "Can you confirm support coverage for the release window?",
        createdAt: "2026-08-21T09:31:00.000Z",
        sequence: 1,
      },
      {
        id: "landing-direct-maya-2",
        threadId: "direct-maya",
        senderMemberId: "member-maya",
        recipientMemberId: "member-self",
        text: "Yes. I have the first two hours, and the EU handoff starts at 14:00 UTC.",
        createdAt: "2026-08-21T09:34:00.000Z",
        sequence: 2,
      },
      {
        id: "landing-direct-maya-3",
        threadId: "direct-maya",
        senderMemberId: "member-self",
        recipientMemberId: "member-maya",
        text: "Great. I added both owners to the rollout checklist.",
        createdAt: "2026-08-21T09:36:00.000Z",
        sequence: 3,
      },
    ],
  },
  "member-jon": {
    threadId: "direct-jon",
    otherMemberId: "member-jon",
    revision: 1,
    readState: {
      unreadCount: 0,
      firstUnreadMessageId: null,
      throughSequence: 3,
    },
    messages: [
      {
        id: "landing-direct-jon-1",
        threadId: "direct-jon",
        senderMemberId: "member-jon",
        recipientMemberId: "member-self",
        text: "The rollback drill passed on staging. Recovery took four minutes.",
        createdAt: "2026-08-21T09:12:00.000Z",
        sequence: 1,
      },
      {
        id: "landing-direct-jon-2",
        threadId: "direct-jon",
        senderMemberId: "member-self",
        recipientMemberId: "member-jon",
        text: "Nice. Any open risk before Builder closes the checklist?",
        createdAt: "2026-08-21T09:15:00.000Z",
        sequence: 2,
      },
      {
        id: "landing-direct-jon-3",
        threadId: "direct-jon",
        senderMemberId: "member-jon",
        recipientMemberId: "member-self",
        text: "Only the analytics alert. It is non-blocking and documented for the release window.",
        createdAt: "2026-08-21T09:18:00.000Z",
        sequence: 3,
      },
    ],
  },
};

const LANDING_PREVIEW_DIRECT_THREADS: DirectThreadSummary[] = Object.values(LANDING_PREVIEW_DIRECT_SNAPSHOTS).map(
  (snapshot) => ({
    threadId: snapshot.threadId,
    otherMemberId: snapshot.otherMemberId,
    lastMessage: snapshot.messages[snapshot.messages.length - 1],
    unreadCount: snapshot.readState?.unreadCount ?? 0,
    updatedAt: snapshot.messages[snapshot.messages.length - 1].createdAt,
  }),
);

export const LANDING_PREVIEW_OPTIONS = {
  bots: LANDING_PREVIEW_BOTS,
  snapshots: LANDING_PREVIEW_SNAPSHOTS,
  servers: LANDING_PREVIEW_SERVERS,
  directThreads: LANDING_PREVIEW_DIRECT_THREADS,
  directSnapshots: LANDING_PREVIEW_DIRECT_SNAPSHOTS,
  browserControlState: { sessions: [] },
} satisfies MockOpenBotOptions;
