import { createMemo, For } from "solid-js";
import type { BotProfile } from "../../data";
import { AgentAvatar } from "../AgentAvatar";
import { LinkIcon } from "./ConversationIcons";

export function RichMessageText(props: {
  body: string;
  bots: BotProfile[];
  onSelectAgent: (botId: string) => void;
  onOpenLink: (url: string) => void;
}) {
  const parts = createMemo(() => richMessageParts(props.body, props.bots));
  return (
    <For each={parts()}>
      {(part) => {
        if (part.url) {
          return (
            <a
              class="message-link"
              href={part.url}
              title={part.url}
              onClick={(event) => {
                event.preventDefault();
                props.onOpenLink(part.url ?? "");
              }}
            >
              <span class="message-link-icon" aria-hidden="true">
                <LinkIcon />
                <img
                  src={faviconUrl(part.url)}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  referrerpolicy="no-referrer"
                  onError={(event) => event.currentTarget.remove()}
                />
              </span>
              {part.text}
            </a>
          );
        }
        if (part.bot) {
          return (
            <button
              type="button"
              class="message-agent-tag"
              aria-label={`Open agent ${part.bot.name}`}
              onClick={() => props.onSelectAgent(part.bot?.id ?? "")}
            >
              <AgentAvatar bot={part.bot} />
              <span>{part.bot.name}</span>
            </button>
          );
        }
        return part.text;
      }}
    </For>
  );
}

interface RichMessagePart {
  text: string;
  bot?: BotProfile;
  url?: string;
}

function richMessageParts(body: string, bots: BotProfile[]): RichMessagePart[] {
  const parts: RichMessagePart[] = [];
  for (const part of linkedMessageParts(body)) {
    if (part.url) parts.push(part);
    else parts.push(...taggedMessageParts(part.text, bots));
  }
  return parts;
}

function linkedMessageParts(body: string): RichMessagePart[] {
  const expression = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()]+)/giu;
  const parts: RichMessagePart[] = [];
  let cursor = 0;
  for (const match of body.matchAll(expression)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push({ text: body.slice(cursor, index) });
    const markdownUrl = match[2];
    const rawUrl = match[3];
    const rawLink = markdownUrl ?? rawUrl ?? "";
    const cleanLink = rawLink.replace(/[.,!?;:]+$/u, "");
    const url = safeBrowserUrl(cleanLink);
    if (!url) {
      parts.push({ text: match[0] });
    } else {
      parts.push({ text: match[1] ?? cleanLink, url });
      const trailingText = rawLink.slice(cleanLink.length);
      if (trailingText) parts.push({ text: trailingText });
    }
    cursor = index + match[0].length;
  }
  if (cursor < body.length) parts.push({ text: body.slice(cursor) });
  return parts.length > 0 ? parts : [{ text: body }];
}

function safeBrowserUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function faviconUrl(value: string): string {
  return `${new URL(value).origin}/favicon.ico`;
}

function taggedMessageParts(body: string, bots: BotProfile[]) {
  const orderedBots = [...bots].sort((left, right) => right.name.length - left.name.length);
  if (orderedBots.length === 0) return [{ text: body, bot: undefined }];
  const botsByName = new Map(orderedBots.map((bot) => [bot.name.toLocaleLowerCase(), bot]));
  const expression = new RegExp(
    `@(${orderedBots.map((bot) => escapeExpression(bot.name)).join("|")})(?=$|[\\s.,!?;:()\\[\\]{}])`,
    "giu",
  );
  const parts: Array<{ text: string; bot: BotProfile | undefined }> = [];
  let cursor = 0;
  for (const match of body.matchAll(expression)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push({ text: body.slice(cursor, index), bot: undefined });
    const name = match[1] ?? "";
    const bot = botsByName.get(name.toLocaleLowerCase());
    parts.push({ text: match[0], bot });
    cursor = index + match[0].length;
  }
  if (cursor < body.length) parts.push({ text: body.slice(cursor), bot: undefined });
  return parts.length > 0 ? parts : [{ text: body, bot: undefined }];
}

function escapeExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
