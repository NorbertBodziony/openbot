import type {
  AgentExchangeSummary,
  AttachmentSummary,
  BotAvatarColor,
  BotAvatarShape,
} from "../../shared/ipc";

export type BotAccent = "teal" | "orange" | "purple" | "blue" | "violet" | "coral" | "neutral";

export const AVATAR_SHAPES: BotAvatarShape[] = [
  "blob",
  "pebble",
  "squircle",
  "tablet",
  "wedge",
  "hex",
  "cloud",
  "teardrop",
];

export const AVATAR_COLORS: BotAvatarColor[] = [
  "black",
  "brown",
  "red",
  "orange",
  "yellow",
  "green",
  "cyan",
  "blue",
  "violet",
  "magenta",
  "gray",
];

export type MessageKind =
  | "text"
  | "exchange"
  | "checklist"
  | "computer"
  | "routine"
  | "multi"
  | "image"
  | "file"
  | "choice";

export interface BotMessage {
  id: string;
  author: "you" | "bot";
  body: string;
  time: string;
  streaming?: boolean;
  kind?: MessageKind;
  status?: string;
  senderBotId?: string;
  senderLabel?: string;
  replyToMessageId?: string | null;
  attachments?: AttachmentSummary[];
  exchange?: AgentExchangeSummary;
  items?: string[];
  routine?: string;
  mediaUrl?: string;
  mediaAlt?: string;
  fileName?: string;
  fileSize?: string;
  fileType?: string;
  question?: string;
  questionHint?: string;
  choices?: string[];
  inputPlaceholder?: string;
}

export interface BotProfile {
  id: string;
  name: string;
  role: string;
  description: string;
  notifications: boolean;
  threadId: string | null;
  initials: string;
  accent: BotAccent;
  avatarShape: BotAvatarShape;
  avatarColor: BotAvatarColor;
  time: string;
  preview: string;
}

export function accentForAvatarColor(color: BotAvatarColor): BotAccent {
  const accents: Record<BotAvatarColor, BotAccent> = {
    black: "neutral",
    brown: "coral",
    red: "coral",
    orange: "orange",
    yellow: "orange",
    green: "teal",
    cyan: "teal",
    blue: "blue",
    violet: "violet",
    magenta: "purple",
    gray: "neutral",
  };
  return accents[color];
}

export function accentForBot(id: string): BotAccent {
  const accents: BotAccent[] = ["teal", "orange", "purple", "blue", "violet", "coral"];
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return accents[hash % accents.length] ?? "neutral";
}
