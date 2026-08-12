export type BotAccent = "teal" | "orange" | "purple" | "blue" | "violet" | "coral" | "neutral";

export type MessageKind = "text" | "checklist" | "computer" | "routine" | "multi";

export interface BotMessage {
  author: "you" | "bot";
  body: string;
  time: string;
  kind?: MessageKind;
  items?: string[];
  status?: string;
  routine?: string;
}

export interface BotProfile {
  id: string;
  name: string;
  role: string;
  initials: string;
  accent: BotAccent;
  time: string;
  preview: string;
  messages: BotMessage[];
}

const salesMessages: BotMessage[] = [
  {
    author: "bot",
    body: "Hey Armand, good to meet you. What do you want me around for? Anything concrete, or more of a general sidekick?",
    time: "15:05",
  },
  {
    author: "you",
    body: "Overnight pipeline generation and outbound. Pick eligible prospects from this Google Sheet, research them on the web, grab context on contacts and accounts from Hex, Sumble, and Salesforce. Draft email and LinkedIn sequences in my voice.",
    time: "15:34",
  },
  {
    author: "bot",
    body: "Checking what's connected. Hex, Gmail, and LinkedIn are already signed in. Salesforce isn't.",
    time: "15:34",
    status: "Needs your attention",
  },
  {
    author: "bot",
    body: "Sign in to Salesforce so I can see the accounts you own.",
    time: "15:34",
    kind: "computer",
    status: "Done",
  },
  {
    author: "bot",
    body: "Salesforce → list pulled · 52 accounts\nHex → 3 lookalike segments pulled\nLinkedIn → 4 profiles skipped · recently contacted\nSequencer → 36 drafts queued · 0 sent",
    time: "15:34",
    kind: "checklist",
    items: [
      "Salesforce → list pulled · 52 accounts",
      "Hex → 3 lookalike segments pulled",
      "LinkedIn → 4 profiles skipped · recently contacted",
      "Sequencer → 36 drafts queued · 0 sent",
    ],
  },
  {
    author: "bot",
    body: "Account Manager sent over the Acme + Globex threads and Chief flagged the priority accounts. Both are folded into tonight's list.",
    time: "15:34",
    kind: "multi",
  },
  {
    author: "bot",
    body: "The 36 drafts are sitting in the LinkedIn queue on my screen: recipient, opener, and a Draft badge on each. Nothing goes out until you've had a look.",
    time: "15:34",
  },
  {
    author: "you",
    body: "The top 10 look good. Send it. Run this every week.",
    time: "15:34",
  },
  {
    author: "bot",
    body: "Created routine",
    time: "15:34",
    kind: "routine",
    routine: "Overnight outbound",
  },
  {
    author: "bot",
    body: "Done.",
    time: "15:34",
  },
];

export const bots: BotProfile[] = [
  {
    id: "chief",
    name: "Chief",
    role: "Chief of staff",
    initials: "C",
    accent: "teal",
    time: "Yesterday",
    preview: "booked the venue and sent the confirmation around.",
    messages: [
      {
        author: "bot",
        body: "I pulled together the open threads and put the decisions that need you first.",
        time: "09:12",
      },
      {
        author: "you",
        body: "Give me the short version before the first meeting.",
        time: "09:14",
      },
      {
        author: "bot",
        body: "The venue is booked, the confirmation is out, and the three decisions are ready in your review list.",
        time: "09:16",
        status: "Worked across 4 threads",
      },
    ],
  },
  {
    id: "sales-outbound",
    name: "Sales Outbound",
    role: "Outbound specialist",
    initials: "S",
    accent: "orange",
    time: "15:05",
    preview: "Done.",
    messages: salesMessages,
  },
  {
    id: "inbox-manager",
    name: "Inbox Manager",
    role: "Inbox operations",
    initials: "I",
    accent: "violet",
    time: "12:04",
    preview: "sent. inbox at zero, 5 drafts parked for tomorrow.",
    messages: [
      {
        author: "you",
        body: "Get the inbox back to zero and keep anything that needs my voice in drafts.",
        time: "12:10",
      },
      {
        author: "bot",
        body: "Done. Five drafts are parked for tomorrow and nothing sensitive was sent without a look.",
        time: "12:04",
        status: "Inbox at zero",
      },
    ],
  },
  {
    id: "account-manager",
    name: "Account Manager",
    role: "Customer accounts",
    initials: "A",
    accent: "purple",
    time: "10:04",
    preview: "invite's out to vicky. globex note held in drafts.",
    messages: [
      {
        author: "you",
        body: "Where are we with Acme? Renewal can't sneak up on us.",
        time: "09:34",
      },
      {
        author: "bot",
        body: "Acme renews in 60 days. Usage is up 18% this quarter, and I drafted the renewal call for the week of the 18th.",
        time: "10:34",
        status: "Memory updated",
      },
      {
        author: "bot",
        body: "The Globex re-engagement note is holding in drafts until you've read it.",
        time: "10:34",
      },
    ],
  },
  {
    id: "talent-scout",
    name: "Talent Scout",
    role: "Recruiting research",
    initials: "T",
    accent: "blue",
    time: "07:04",
    preview: "3 intros drafted in your voice, held for your ok.",
    messages: [
      {
        author: "bot",
        body: "Three intros are drafted in your voice and held for your ok. I left out anyone contacted in the last 30 days.",
        time: "07:04",
        status: "3 intros drafted",
      },
    ],
  },
  {
    id: "expense-manager",
    name: "Expense Manager",
    role: "Finance operations",
    initials: "E",
    accent: "coral",
    time: "11:04",
    preview: "report filed. 9 receipts, nothing outstanding.",
    messages: [
      {
        author: "you",
        body: "Close out this month's receipts and flag anything unusual.",
        time: "11:02",
      },
      {
        author: "bot",
        body: "Report filed. Nine receipts matched, nothing is outstanding, and one line item is ready for your review.",
        time: "11:34",
        status: "9 receipts matched",
      },
    ],
  },
  {
    id: "offsite-crew",
    name: "Offsite crew",
    role: "Project planning",
    initials: "O",
    accent: "teal",
    time: "09:04",
    preview: "that leaves the pipeline. i'd spin up a dedicated agent.",
    messages: [
      {
        author: "bot",
        body: "That leaves the pipeline. I'd spin up a dedicated agent and keep the venue thread moving here.",
        time: "09:34",
      },
    ],
  },
];
