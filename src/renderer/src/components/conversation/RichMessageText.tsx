import { attachmentReferences } from "@openbot/contracts/attachment-references";
import type { AttachmentSummary } from "@openbot/contracts/ipc";
import { createMemo, createSignal, createUniqueId, For, Show } from "solid-js";
import type { BotProfile, MessageCitation } from "../../data";
import { AgentAvatar } from "../AgentAvatar";
import { Button } from "../ui";
import { AnchoredTooltip } from "./AnchoredTooltip";
import { AttachmentReferenceVisual } from "./AttachmentReference";
import { LinkIcon } from "./ConversationIcons";

export function RichMessageText(props: {
  body: string;
  bots: BotProfile[];
  attachments?: AttachmentSummary[];
  citations?: MessageCitation[];
  onSelectAgent: (botId: string) => void;
  onOpenLink: (url: string) => void;
  onOpenAttachment?: (attachment: AttachmentSummary) => void;
  showCitationFooter?: boolean;
}) {
  const citationsByNumber = createMemo(
    () => new Map((props.citations ?? []).map((citation) => [citation.number, citation])),
  );
  const attachmentsById = createMemo(
    () => new Map((props.attachments ?? []).map((attachment) => [attachment.id, attachment])),
  );
  const parts = createMemo(() => richMessageParts(props.body, props.bots, citationsByNumber(), attachmentsById()));
  const citations = createMemo(() => (props.citations ?? []).filter((citation) => safeBrowserUrl(citation.url)));
  const tooltipId = `rich-message-tooltip-${createUniqueId()}`;
  const [tooltip, setTooltip] = createSignal<{
    anchor: HTMLElement;
    content: string;
    light: boolean;
  } | null>(null);

  const openTooltip = (anchor: HTMLElement, content: string, onlyWhenTruncated = false) => {
    const label = anchor.querySelector<HTMLElement>(".inline-file-reference-name");
    if (onlyWhenTruncated && (!label || label.scrollWidth <= label.clientWidth + 1)) {
      setTooltip(null);
      return;
    }
    setTooltip({
      anchor,
      content,
      light: Boolean(anchor.closest(".user-bubble")),
    });
  };
  const closeTooltip = (anchor: HTMLElement) => {
    if (tooltip()?.anchor === anchor) setTooltip(null);
  };
  const closeTooltipOnEscape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    if (!(event.currentTarget instanceof HTMLElement)) return;
    closeTooltip(event.currentTarget);
  };

  return (
    <>
      <For each={parts()}>
        {(part) => {
          const attachment = part.attachment;
          if (attachment) {
            return (
              <Button
                type="button"
                class="message-file-reference"
                aria-label={`Open attached file ${attachment.name}`}
                aria-describedby={tooltipId}
                onPointerEnter={(event) => openTooltip(event.currentTarget, attachment.name, true)}
                onMouseEnter={(event) => openTooltip(event.currentTarget, attachment.name, true)}
                onPointerLeave={(event) => closeTooltip(event.currentTarget)}
                onMouseLeave={(event) => closeTooltip(event.currentTarget)}
                onFocus={(event) => openTooltip(event.currentTarget, attachment.name, true)}
                onBlur={(event) => closeTooltip(event.currentTarget)}
                onKeyDown={closeTooltipOnEscape}
                onClick={(event) => {
                  if (!usesTouchLayout()) setTooltip(null);
                  else openTooltip(event.currentTarget, attachment.name, true);
                  props.onOpenAttachment?.(attachment);
                }}
              >
                <AttachmentReferenceVisual name={attachment.name} />
                <span class="inline-file-reference-name">{attachment.name}</span>
              </Button>
            );
          }
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
              <Button
                type="button"
                class="message-agent-tag"
                aria-label={`Open agent ${part.bot.name}`}
                onClick={() => props.onSelectAgent(part.bot?.id ?? "")}
              >
                <AgentAvatar bot={part.bot} />
                <span>{part.bot.name}</span>
              </Button>
            );
          }
          if (part.citation) {
            return (
              <span class="message-citation">
                <a
                  class="message-citation-mark"
                  href={part.citation.url}
                  aria-label={`Open citation ${part.citation.number}: ${part.citation.label}`}
                  aria-describedby={tooltipId}
                  onPointerEnter={(event) => openTooltip(event.currentTarget, part.citation?.label ?? "")}
                  onMouseEnter={(event) => openTooltip(event.currentTarget, part.citation?.label ?? "")}
                  onPointerLeave={(event) => closeTooltip(event.currentTarget)}
                  onMouseLeave={(event) => closeTooltip(event.currentTarget)}
                  onFocus={(event) => openTooltip(event.currentTarget, part.citation?.label ?? "")}
                  onBlur={(event) => closeTooltip(event.currentTarget)}
                  onKeyDown={closeTooltipOnEscape}
                  onClick={(event) => {
                    event.preventDefault();
                    setTooltip(null);
                    props.onOpenLink(part.citation?.url ?? "");
                  }}
                >
                  {part.citation.number}
                </a>
              </span>
            );
          }
          return part.text;
        }}
      </For>
      <Show when={props.showCitationFooter !== false && citations().length > 0}>
        <span class="message-citation-footer">
          <For each={citations()}>
            {(citation) => (
              <a
                class="message-citation-ref"
                href={citation.url}
                aria-label={`Open source ${citation.number}: ${citation.label}`}
                onClick={(event) => {
                  event.preventDefault();
                  props.onOpenLink(citation.url);
                }}
              >
                <span class="message-citation-mark">{citation.number}</span>
                <span class="message-citation-ref-label">{citation.label}</span>
                <span class="message-citation-separator" aria-hidden="true">
                  ·
                </span>
                <span class="message-citation-ref-host">{citation.host ?? citationHost(citation.url)}</span>
                <span class="message-citation-arrow" aria-hidden="true">
                  <CitationArrowIcon />
                </span>
              </a>
            )}
          </For>
        </span>
      </Show>
      <Show when={tooltip()}>
        {(activeTooltip) => (
          <AnchoredTooltip
            id={tooltipId}
            anchor={activeTooltip().anchor}
            content={activeTooltip().content}
            light={activeTooltip().light}
          />
        )}
      </Show>
    </>
  );
}

function usesTouchLayout(): boolean {
  return window.matchMedia?.("(hover: none), (pointer: coarse)").matches ?? false;
}

interface RichMessagePart {
  text: string;
  bot?: BotProfile;
  citation?: MessageCitation;
  attachment?: AttachmentSummary;
  url?: string;
}

function richMessageParts(
  body: string,
  bots: BotProfile[],
  citationsByNumber: Map<number, MessageCitation>,
  attachmentsById: Map<string, AttachmentSummary>,
): RichMessagePart[] {
  const parts: RichMessagePart[] = [];
  for (const referencedPart of referencedMessageParts(body, attachmentsById)) {
    if (referencedPart.attachment) {
      parts.push(referencedPart);
      continue;
    }
    for (const part of linkedMessageParts(referencedPart.text)) {
      if (part.url) parts.push(part);
      else {
        for (const taggedPart of taggedMessageParts(part.text, bots)) {
          if (taggedPart.bot) {
            parts.push(taggedPart);
          } else {
            parts.push(...citedMessageParts(taggedPart.text, citationsByNumber));
          }
        }
      }
    }
  }
  return parts;
}

function referencedMessageParts(body: string, attachmentsById: Map<string, AttachmentSummary>): RichMessagePart[] {
  const references = attachmentReferences(body);
  if (references.length === 0) return [{ text: body }];
  const parts: RichMessagePart[] = [];
  let cursor = 0;
  for (const reference of references) {
    if (reference.start > cursor) parts.push({ text: body.slice(cursor, reference.start) });
    const attachment = attachmentsById.get(reference.attachmentId);
    parts.push(attachment ? { text: reference.name, attachment } : { text: reference.name });
    cursor = reference.end;
  }
  if (cursor < body.length) parts.push({ text: body.slice(cursor) });
  return parts;
}

function citedMessageParts(body: string, citationsByNumber: Map<number, MessageCitation>) {
  if (citationsByNumber.size === 0) return [{ text: body }];
  const parts: RichMessagePart[] = [];
  const expression = /\[(\d+)\]/gu;
  let cursor = 0;
  for (const match of body.matchAll(expression)) {
    const index = match.index ?? 0;
    const number = Number(match[1]);
    const citation = citationsByNumber.get(number);
    if (!citation) continue;
    if (index > cursor) parts.push({ text: body.slice(cursor, index) });
    parts.push({ text: match[0], citation });
    cursor = index + match[0].length;
  }
  if (cursor < body.length) parts.push({ text: body.slice(cursor) });
  return parts.length > 0 ? parts : [{ text: body }];
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

function citationHost(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./u, "");
  } catch {
    return value;
  }
}

function CitationArrowIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M4.5 10.5 12 3m0 0 7.5 7.5M12 3v18" />
    </svg>
  );
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
