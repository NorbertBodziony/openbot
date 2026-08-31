import { serializeChatTagReference } from "@openbot/contracts/chat-tag-references";
import { Dynamic } from "@solidjs/web";
import type { Token, Tokens } from "marked";
import { marked } from "marked";
import { createMemo, For, Show } from "solid-js";
import { Button, Checkbox } from "../ui";
import { AttachmentReferenceVisual, attachmentReferenceTone } from "./AttachmentReference";
import { CodeBlock } from "./CodeBlock";
import { MessageLink, RichMessageText, type RichMessageTextProps, safeBrowserUrl } from "./RichMessageText";

type MarkdownMessageTextProps = Omit<RichMessageTextProps, "showCitationFooter"> & {
  showCitationFooter?: boolean;
  streaming?: boolean;
  streamingTail?: boolean;
};

type MarkdownContentProps = Omit<
  MarkdownMessageTextProps,
  "body" | "showCitationFooter" | "streaming" | "streamingTail"
> & {
  fileDirectory: FileDirectoryContext | null;
};

interface FileDirectoryContext {
  path: string;
  kind: "shared" | "workspace";
}

interface MarkdownTokenByType {
  heading: Tokens.Heading;
  paragraph: Tokens.Paragraph;
  blockquote: Tokens.Blockquote;
  list: Tokens.List;
  code: Tokens.Code;
  table: Tokens.Table;
  text: Tokens.Text;
  strong: Tokens.Strong;
  em: Tokens.Em;
  del: Tokens.Del;
  codespan: Tokens.Codespan;
  link: Tokens.Link;
  image: Tokens.Image;
  escape: Tokens.Escape;
}

const VOID_HTML_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

function tokenIs<K extends keyof MarkdownTokenByType>(token: Token, type: K): token is MarkdownTokenByType[K] {
  return token.type === type;
}

function headingLevel(depth: number): 1 | 2 | 3 | 4 | 5 | 6 {
  if (depth <= 1) return 1;
  if (depth === 2) return 2;
  if (depth === 3) return 3;
  if (depth === 4) return 4;
  if (depth === 5) return 5;
  return 6;
}

export function MarkdownMessageText(props: MarkdownMessageTextProps) {
  const tokens = createMemo(() => marked.lexer(props.body, { breaks: true, gfm: true }));
  const contentProps = (): MarkdownContentProps => ({
    bots: props.bots,
    skills: props.skills,
    attachments: props.attachments,
    citations: props.citations,
    onSelectAgent: props.onSelectAgent,
    onOpenLink: props.onOpenLink,
    onOpenAttachment: props.onOpenAttachment,
    onOpenSharedFile: props.onOpenSharedFile,
    onOpenWorkspaceFile: props.onOpenWorkspaceFile,
    fileDirectory: messageFileDirectory(props.body),
  });

  return (
    <>
      <MarkdownBlocks
        tokens={tokens()}
        content={contentProps()}
        streaming={props.streaming}
        streamingTail={props.streamingTail}
      />
      <Show when={props.showCitationFooter !== false && (props.citations?.length ?? 0) > 0}>
        <RichMessageText {...contentProps()} body="" />
      </Show>
    </>
  );
}

export function MarkdownInlineText(
  props: Omit<MarkdownMessageTextProps, "showCitationFooter" | "streaming" | "streamingTail">,
) {
  const tokens = createMemo(() => marked.Lexer.lexInline(props.body, { breaks: true, gfm: true }));
  const contentProps = (): MarkdownContentProps => ({
    bots: props.bots,
    skills: props.skills,
    attachments: props.attachments,
    citations: props.citations,
    onSelectAgent: props.onSelectAgent,
    onOpenLink: props.onOpenLink,
    onOpenAttachment: props.onOpenAttachment,
    onOpenSharedFile: props.onOpenSharedFile,
    onOpenWorkspaceFile: props.onOpenWorkspaceFile,
    fileDirectory: messageFileDirectory(props.body),
  });
  return <MarkdownInline tokens={tokens()} content={contentProps()} />;
}

function MarkdownBlocks(props: {
  tokens: Token[];
  content: MarkdownContentProps;
  streaming?: boolean;
  streamingTail?: boolean;
}) {
  const tokens = createMemo(() => props.tokens);
  const renderedTokens = createMemo(() => {
    const values = tokens();
    const lastTokenIndex = lastRenderableTokenIndex(values);
    const streamingTokenIndex = activeStreamingBlockTokenIndex(values);
    return values.map((token, index) => ({
      token,
      streaming: props.streaming === true && index === streamingTokenIndex,
      streamingTail: props.streamingTail === true && index === lastTokenIndex,
    }));
  });
  return (
    <For each={renderedTokens()}>
      {(item) => (
        <MarkdownBlock
          token={item.token}
          content={props.content}
          streaming={item.streaming}
          streamingTail={item.streamingTail}
        />
      )}
    </For>
  );
}

function MarkdownBlock(props: {
  token: Token;
  content: MarkdownContentProps;
  streaming?: boolean;
  streamingTail?: boolean;
}) {
  const token = props.token;
  switch (token.type) {
    case "space":
    case "def":
      return null;
    case "heading": {
      if (!tokenIs(token, "heading")) return token.raw;
      const level = headingLevel(token.depth);
      return (
        <Dynamic component={`h${level}`} class="message-markdown-heading" data-level={level}>
          <MarkdownInline
            tokens={token.tokens}
            content={props.content}
            streaming={props.streaming}
            streamingTail={props.streamingTail}
          />
        </Dynamic>
      );
    }
    case "paragraph": {
      if (!tokenIs(token, "paragraph")) return token.raw;
      return (
        <p>
          <MarkdownInline
            tokens={token.tokens}
            content={props.content}
            streaming={props.streaming}
            streamingTail={props.streamingTail}
          />
        </p>
      );
    }
    case "blockquote": {
      if (!tokenIs(token, "blockquote")) return token.raw;
      return (
        <blockquote>
          <MarkdownBlocks
            tokens={token.tokens}
            content={props.content}
            streaming={props.streaming === true && !containerClosesFinalNestedTable(token)}
            streamingTail={props.streamingTail}
          />
        </blockquote>
      );
    }
    case "list": {
      if (!tokenIs(token, "list")) return token.raw;
      return (
        <MarkdownList
          token={token}
          content={props.content}
          streaming={props.streaming === true && !containerClosesFinalNestedTable(token)}
          streamingTail={props.streamingTail}
        />
      );
    }
    case "code": {
      if (!tokenIs(token, "code")) return token.raw;
      const language = token.lang?.trim().split(/\s+/u)[0] ?? "";
      return <CodeBlock block={{ type: "code", code: token.text, language }} streaming={props.streaming === true} />;
    }
    case "table": {
      if (!tokenIs(token, "table")) return token.raw;
      return <MarkdownTable token={token} content={props.content} streaming={props.streaming} />;
    }
    case "hr":
      return <hr />;
    case "html":
      return <span class="message-markdown-raw-html">{token.raw}</span>;
    case "text": {
      if (!tokenIs(token, "text")) return token.raw;
      return token.tokens ? (
        <MarkdownInline
          tokens={token.tokens}
          content={props.content}
          streaming={props.streaming}
          streamingTail={props.streamingTail}
        />
      ) : (
        <RichText
          body={token.text}
          content={props.content}
          streaming={props.streaming}
          streamingTail={props.streamingTail}
        />
      );
    }
    default:
      return (
        <RichText
          body={token.raw}
          content={props.content}
          streaming={props.streaming}
          streamingTail={props.streamingTail}
        />
      );
  }
}

function MarkdownList(props: {
  token: Tokens.List;
  content: MarkdownContentProps;
  streaming?: boolean;
  streamingTail?: boolean;
}) {
  const items = createMemo(() => props.token.items);
  const renderedItems = createMemo(() => {
    const values = items();
    return values.map((item, index) => ({
      item,
      streaming: props.streaming === true && index === values.length - 1,
      streamingTail: props.streamingTail === true && index === values.length - 1,
    }));
  });
  const list = () => (
    <For each={renderedItems()}>
      {(renderedItem) => (
        <li class={renderedItem.item.task ? "message-markdown-task" : undefined}>
          <Show when={renderedItem.item.task}>
            <Checkbox
              class="message-markdown-checkbox"
              checked={renderedItem.item.checked === true}
              disabled
              aria-label={renderedItem.item.text}
            />
          </Show>
          <MarkdownBlocks
            tokens={renderedItem.item.tokens.filter((child) => child.type !== "checkbox")}
            content={props.content}
            streaming={renderedItem.streaming}
            streamingTail={renderedItem.streamingTail}
          />
        </li>
      )}
    </For>
  );

  return props.token.ordered ? (
    <ol start={props.token.start === "" ? undefined : props.token.start}>{list()}</ol>
  ) : (
    <ul>{list()}</ul>
  );
}

function MarkdownTable(props: { token: Tokens.Table; content: MarkdownContentProps; streaming?: boolean }) {
  const headers = createMemo(() => props.token.header);
  const rows = createMemo(() => props.token.rows);
  const streamingCellIndex = createMemo(() =>
    props.streaming === true ? activeStreamingTableCellIndex(props.token) : -1,
  );
  return (
    <section class="message-markdown-table-scroll" aria-label="Data table" tabindex="0">
      <table class="message-markdown-table">
        <thead>
          <tr>
            <For each={headers()}>
              {(cell) => (
                <th scope="col" data-align={cell.align ?? "left"}>
                  <MarkdownInline tokens={cell.tokens} content={props.content} />
                </th>
              )}
            </For>
          </tr>
        </thead>
        <tbody>
          <For each={rows()}>
            {(row, rowIndex) => (
              <tr>
                <For each={row}>
                  {(cell, cellIndex) => (
                    <td data-align={cell.align ?? "left"}>
                      <MarkdownInline
                        tokens={cell.tokens}
                        content={props.content}
                        streaming={rowIndex() === rows().length - 1 && cellIndex() === streamingCellIndex()}
                      />
                    </td>
                  )}
                </For>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </section>
  );
}

function MarkdownInline(props: {
  tokens: Token[];
  content: MarkdownContentProps;
  streaming?: boolean;
  streamingTail?: boolean;
}) {
  const tokens = createMemo(() => repairEscapedLocalFileLinkTokens(props.tokens));
  const renderedTokens = createMemo(() => {
    const values = tokens();
    const lastTokenIndex = lastRenderableTokenIndex(values);
    const markerTokenIndexes =
      props.streaming === true ? incompleteEmphasisMarkerTokenIndexes(values) : new Set<number>();
    return values.map((token, index) => ({
      token,
      streaming: markerTokenIndexes.has(index),
      semanticTag: index > 0 && textTokenEndsWithTagMarker(values[index - 1]) ? semanticChatTag(token) : null,
      precedesSemanticTag: textTokenEndsWithTagMarker(token) && semanticChatTag(values[index + 1]) !== null,
      streamingTail: props.streamingTail === true && index === lastTokenIndex,
    }));
  });
  return (
    <For each={renderedTokens()}>
      {(item) => {
        const token = item.token;
        switch (token.type) {
          case "strong":
            if (!tokenIs(token, "strong")) return token.raw;
            return (
              <strong>
                <MarkdownInline tokens={token.tokens} content={props.content} streamingTail={item.streamingTail} />
              </strong>
            );
          case "em":
            if (!tokenIs(token, "em")) return token.raw;
            return (
              <em>
                <MarkdownInline tokens={token.tokens} content={props.content} streamingTail={item.streamingTail} />
              </em>
            );
          case "del":
            if (!tokenIs(token, "del")) return token.raw;
            return (
              <del>
                <MarkdownInline tokens={token.tokens} content={props.content} streamingTail={item.streamingTail} />
              </del>
            );
          case "codespan": {
            if (!tokenIs(token, "codespan")) return token.raw;
            const file = mentionedFileTarget(token.text, props.content.fileDirectory);
            return file && file.kind === "shared" && props.content.onOpenSharedFile ? (
              <LocalFileLink
                path={file.path}
                label={token.text}
                kind="shared"
                onOpen={props.content.onOpenSharedFile}
              />
            ) : file && file.kind === "workspace" && props.content.onOpenWorkspaceFile ? (
              <LocalFileLink
                path={file.path}
                label={token.text}
                kind="workspace"
                onOpen={props.content.onOpenWorkspaceFile}
              />
            ) : (
              <code>{token.text}</code>
            );
          }
          case "br":
            return <br />;
          case "link": {
            if (!tokenIs(token, "link")) return token.raw;
            if (item.semanticTag) {
              return <RichText body={item.semanticTag} content={props.content} streamingTail={item.streamingTail} />;
            }
            const url = safeBrowserUrl(token.href);
            const sharedPath = sharedFileTarget(token.href);
            const workspacePath = workspaceFileTarget(token.href);
            return url ? (
              <MessageLink url={url} title={token.title} onOpenLink={props.content.onOpenLink}>
                {token.text === token.href ? (
                  token.text
                ) : (
                  <MarkdownInline tokens={token.tokens} content={props.content} streamingTail={item.streamingTail} />
                )}
              </MessageLink>
            ) : sharedPath && props.content.onOpenSharedFile ? (
              <LocalFileLink
                path={sharedPath}
                label={markdownInlinePlainText(token.tokens) || token.text}
                kind="shared"
                onOpen={props.content.onOpenSharedFile}
              />
            ) : workspacePath && props.content.onOpenWorkspaceFile ? (
              <LocalFileLink
                path={workspacePath}
                label={markdownInlinePlainText(token.tokens) || token.text}
                kind="workspace"
                onOpen={props.content.onOpenWorkspaceFile}
              />
            ) : (
              <RichText body={token.text} content={props.content} streamingTail={item.streamingTail} />
            );
          }
          case "image": {
            if (!tokenIs(token, "image")) return token.raw;
            const url = safeBrowserUrl(token.href);
            return url ? (
              <img
                class="message-markdown-image"
                src={url}
                alt={token.text}
                title={token.title ?? undefined}
                loading="lazy"
                decoding="async"
                referrerpolicy="no-referrer"
              />
            ) : (
              <RichText body={token.text || token.raw} content={props.content} streamingTail={item.streamingTail} />
            );
          }
          case "html":
            return token.raw;
          case "escape": {
            if (!tokenIs(token, "escape")) return token.raw;
            return <RichText body={token.text} content={props.content} streamingTail={item.streamingTail} />;
          }
          case "text": {
            if (!tokenIs(token, "text")) return token.raw;
            return token.tokens ? (
              <MarkdownInline
                tokens={token.tokens}
                content={props.content}
                streaming={item.streaming}
                streamingTail={item.streamingTail}
              />
            ) : (
              <RichText
                body={item.precedesSemanticTag ? token.text.slice(0, -1) : token.text}
                content={props.content}
                streaming={item.streaming}
                streamingTail={item.streamingTail}
              />
            );
          }
          case "checkbox":
            return null;
          default:
            return <RichText body={token.raw} content={props.content} streamingTail={item.streamingTail} />;
        }
      }}
    </For>
  );
}

function textTokenEndsWithTagMarker(token: Token | undefined): boolean {
  return token !== undefined && tokenIs(token, "text") && !token.tokens && token.text.endsWith("@");
}

function semanticChatTag(token: Token | undefined): string | null {
  if (!token || !tokenIs(token, "link")) return null;
  const target = /^(agent|skill):(.+)$/u.exec(token.href);
  const kind = target?.[1] === "agent" ? "agent" : target?.[1] === "skill" ? "skill" : null;
  const id = target?.[2]?.trim();
  const name = (markdownInlinePlainText(token.tokens) || token.text).trim();
  return kind && id && name ? serializeChatTagReference(kind, name, id) : null;
}

function RichText(props: {
  body: string;
  content: MarkdownContentProps;
  streaming?: boolean;
  streamingTail?: boolean;
}) {
  return (
    <RichMessageText
      {...props.content}
      body={props.streaming ? hideIncompleteEmphasisMarker(props.body) : props.body}
      showCitationFooter={false}
      streamingTail={props.streamingTail}
    />
  );
}

function hideIncompleteEmphasisMarker(body: string): string {
  const characters = [...body];
  const markers = incompleteEmphasisMarkers(characters);
  for (const marker of markers.reverse()) characters.splice(marker.index, marker.length);
  return characters.join("");
}

function incompleteEmphasisMarkerTokenIndexes(tokens: Token[]): Set<number> {
  const characters: string[] = [];
  const owners: number[] = [];
  for (const [tokenIndex, token] of tokens.entries()) {
    for (const character of [...token.raw]) {
      characters.push(character);
      owners.push(token.type === "text" ? tokenIndex : -1);
    }
  }
  const markers = incompleteEmphasisMarkers(
    characters,
    (start, end) => owners[start] !== -1 && owners[start] === owners[end - 1],
  );
  return new Set(markers.map((marker) => owners[marker.index]).filter((owner) => owner !== undefined && owner !== -1));
}

function incompleteEmphasisMarkers(
  characters: string[],
  eligible: (start: number, end: number) => boolean = () => true,
): Array<{ index: number; length: number }> {
  const markers: Array<{ index: number; length: number }> = [];
  for (let index = 0; index < characters.length; ) {
    const delimiter = characters[index];
    if (delimiter !== "*" && delimiter !== "_") {
      index += 1;
      continue;
    }
    let runEnd = index + 1;
    while (characters[runEnd] === delimiter) runEnd += 1;
    const previous = characters[index - 1];
    const next = characters[runEnd];
    if (eligible(index, runEnd) && canOpenEmphasisDelimiter(delimiter, previous, next)) {
      markers.push({ index, length: runEnd - index });
    }
    index = runEnd;
  }
  return markers;
}

function canOpenEmphasisDelimiter(delimiter: "*" | "_", previous: string | undefined, next: string | undefined) {
  if (next === undefined) {
    return previous === undefined || isMarkdownWhitespace(previous) || isMarkdownPunctuation(previous);
  }
  return (
    isLeftFlankingMarkdownDelimiter(previous, next) &&
    (delimiter === "*" ||
      !isRightFlankingMarkdownDelimiter(previous, next) ||
      (previous !== undefined && isMarkdownPunctuation(previous)))
  );
}

function isLeftFlankingMarkdownDelimiter(previous: string | undefined, next: string | undefined): boolean {
  return (
    next !== undefined &&
    !isMarkdownWhitespace(next) &&
    (!isMarkdownPunctuation(next) ||
      previous === undefined ||
      isMarkdownWhitespace(previous) ||
      isMarkdownPunctuation(previous))
  );
}

function isRightFlankingMarkdownDelimiter(previous: string | undefined, next: string | undefined): boolean {
  return (
    previous !== undefined &&
    !isMarkdownWhitespace(previous) &&
    (!isMarkdownPunctuation(previous) ||
      next === undefined ||
      isMarkdownWhitespace(next) ||
      isMarkdownPunctuation(next))
  );
}

function isMarkdownWhitespace(value: string): boolean {
  return /\s/u.test(value);
}

function isMarkdownPunctuation(value: string): boolean {
  return /[\p{P}\p{S}]/u.test(value);
}

function lastRenderableTokenIndex(tokens: Token[]): number {
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    if (tokens[index]?.type !== "space" && tokens[index]?.type !== "def") return index;
  }
  return -1;
}

function activeStreamingBlockTokenIndex(tokens: Token[]): number {
  const index = lastRenderableTokenIndex(tokens);
  if (index === -1 || index !== tokens.length - 1) return -1;
  const token = tokens[index];
  if (tokenIs(token, "heading") && token.raw.includes("\n")) return -1;
  return index;
}

function activeStreamingTableCellIndex(token: Tokens.Table): number {
  const row = token.rows.at(-1);
  if (!row || /\n[\t ]*$/u.test(token.raw)) return -1;
  const sourceRow = token.raw.split("\n").at(-1)?.trimEnd();
  if (!sourceRow) return -1;

  const finalCharacterIndex = sourceRow.length - 1;
  if (sourceRow[finalCharacterIndex] === "|" && !isEscapedMarkdownCharacter(sourceRow, finalCharacterIndex)) {
    return -1;
  }

  let sourceIndex = sourceRow.search(/\S/u);
  if (sourceIndex === -1) return -1;
  if (sourceRow[sourceIndex] === "|") sourceIndex += 1;

  let cellIndex = 0;
  for (; sourceIndex < sourceRow.length; sourceIndex += 1) {
    if (sourceRow[sourceIndex] === "|" && !isEscapedMarkdownCharacter(sourceRow, sourceIndex)) cellIndex += 1;
  }
  return cellIndex < row.length ? cellIndex : -1;
}

function containerClosesFinalNestedTable(token: Tokens.Blockquote | Tokens.List): boolean {
  if (!/\n[\t ]*$/u.test(token.raw)) return false;
  return finalNestedBlockToken(token) === "table";
}

function finalNestedBlockToken(token: Tokens.Blockquote | Tokens.List): Token["type"] | undefined {
  if (tokenIs(token, "list")) {
    const item = token.items.at(-1);
    if (!item) return token.type;
    return finalNestedTokenType(item.tokens);
  }
  return finalNestedTokenType(token.tokens);
}

function finalNestedTokenType(tokens: Token[]): Token["type"] | undefined {
  const index = lastRenderableTokenIndex(tokens);
  const token = tokens[index];
  if (!token) return undefined;
  if (tokenIs(token, "blockquote") || tokenIs(token, "list")) return finalNestedBlockToken(token);
  return token.type;
}

function isEscapedMarkdownCharacter(value: string, index: number): boolean {
  let slashCount = 0;
  for (let slashIndex = index - 1; slashIndex >= 0 && value[slashIndex] === "\\"; slashIndex -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function markdownInlinePlainText(tokens: Token[]): string {
  return tokens
    .map((token) => {
      if (tokenIs(token, "strong")) return markdownInlinePlainText(token.tokens);
      if (tokenIs(token, "em")) return markdownInlinePlainText(token.tokens);
      if (tokenIs(token, "del")) return markdownInlinePlainText(token.tokens);
      if (tokenIs(token, "link")) return markdownInlinePlainText(token.tokens);
      if (tokenIs(token, "text")) return token.tokens ? markdownInlinePlainText(token.tokens) : token.text;
      if (tokenIs(token, "codespan") || tokenIs(token, "escape") || tokenIs(token, "image")) return token.text;
      if (token.type === "br") return "\n";
      return token.raw;
    })
    .join("");
}

function LocalFileLink(props: {
  path: string;
  label: string;
  kind: "shared" | "workspace";
  onOpen: (path: string) => void;
}) {
  const name = workspaceFileName(props.path);
  return (
    <Button
      variant="ghost"
      type="button"
      class="message-file-reference"
      data-file-tone={attachmentReferenceTone(name)}
      aria-label={`Open ${props.kind} file ${name}`}
      title={props.path}
      onClick={() => props.onOpen(props.path)}
    >
      <AttachmentReferenceVisual name={name} />
      <span class="inline-file-reference-name">{props.label || name}</span>
    </Button>
  );
}

function sharedFileTarget(value: string): string | null {
  const path = value.trim();
  if (!path || /[\0\r\n]/u.test(path)) return null;
  const normalized = path.replaceAll("\\", "/");
  return normalized.startsWith("~/OpenBot/Shared/") ||
    normalized.startsWith("OpenBot/Shared/") ||
    normalized.includes("/OpenBot/Shared/")
    ? path
    : null;
}

function repairEscapedLocalFileLinkTokens(tokens: Token[]): Token[] {
  const raw = tokens.map((token) => token.raw).join("");
  if (!raw.includes("\\(<")) return tokens;
  const result: Token[] = [];
  let candidates: Token[] = [];
  const openHtmlElements: string[] = [];
  const flushCandidates = () => {
    if (candidates.length === 0) return;
    const source = candidates.map((token) => token.raw).join("");
    const maskedSource = candidates.map(maskProtectedMarkdownToken).join("");
    const repaired = normalizeEscapedLocalFileLinkCandidate(source, maskedSource);
    result.push(...(repaired === source ? candidates : marked.Lexer.lexInline(repaired, { breaks: true, gfm: true })));
    candidates = [];
  };
  for (const token of tokens) {
    if (token.type === "html") {
      flushCandidates();
      result.push(token);
      updateOpenHtmlElements(openHtmlElements, token.raw);
      continue;
    }
    if (openHtmlElements.length > 0) {
      flushCandidates();
      result.push(token);
      continue;
    }
    candidates.push(token);
  }
  flushCandidates();
  return result;
}

function maskProtectedMarkdownToken(token: Token): string {
  if (token.type === "html" || tokenIs(token, "codespan")) return " ".repeat(token.raw.length);
  const children =
    tokenIs(token, "strong") ||
    tokenIs(token, "em") ||
    tokenIs(token, "del") ||
    tokenIs(token, "link") ||
    tokenIs(token, "text")
      ? token.tokens
      : undefined;
  if (!children?.length) return token.raw;

  let masked = token.raw;
  let searchStart = 0;
  for (const child of children) {
    const childStart = token.raw.indexOf(child.raw, searchStart);
    if (childStart < 0) continue;
    const protectedChild = maskProtectedMarkdownToken(child);
    masked = `${masked.slice(0, childStart)}${protectedChild}${masked.slice(childStart + child.raw.length)}`;
    searchStart = childStart + child.raw.length;
  }
  return masked;
}

function updateOpenHtmlElements(elements: string[], raw: string): void {
  if (/^\s*<(?:!--|!|\?)/u.test(raw)) return;
  for (const match of raw.matchAll(/<\s*(\/?)\s*([A-Za-z][\w:-]*)\b[^>]*>/gu)) {
    const name = (match[2] ?? "").toLowerCase();
    if (!name) continue;
    if (match[1]) {
      const openingIndex = elements.lastIndexOf(name);
      if (openingIndex >= 0) elements.splice(openingIndex);
      continue;
    }
    if (!match[0].endsWith("/>") && !VOID_HTML_ELEMENTS.has(name)) elements.push(name);
  }
}

function normalizeEscapedLocalFileLinkCandidate(value: string, maskedValue = value): string {
  const pattern = /(?<!!)(\[[^\]\r\n]+\])\\\(<([^<>\r\n]+)>(\\?\))/gu;
  let result = "";
  let cursor = 0;
  for (const match of maskedValue.matchAll(pattern)) {
    const start = match.index;
    const labelLength = match[1]?.length ?? 0;
    const targetLength = match[2]?.length ?? 0;
    const targetStart = start + labelLength + 3;
    const target = value.slice(targetStart, targetStart + targetLength);
    if (!localFileTarget(target)) continue;
    const label = value.slice(start, start + labelLength);
    result += `${value.slice(cursor, start)}${label}(<${target}>)`;
    cursor = start + match[0].length;
  }
  return cursor === 0 ? value : result + value.slice(cursor);
}

function localFileTarget(value: string): string | null {
  const path = value.trim();
  if (path.startsWith("//")) return null;
  const workspace = workspaceFileTarget(path);
  if (!workspace) return null;
  const shared = sharedFileTarget(path);
  if (shared) return shared;
  return /^(?:~[/\\]|[/\\]|[A-Za-z]:[/\\])/u.test(path) || isFileMention(path) ? workspace : null;
}

function workspaceFileTarget(value: string): string | null {
  const path = value.trim();
  if (!path || /[\0\r\n]/u.test(path) || path.startsWith("#")) return null;
  if (/^[A-Za-z]:[/\\]/u.test(path)) return path;
  if (/^[A-Za-z][A-Za-z\d+.-]*:/u.test(path)) return null;
  return path;
}

function workspaceFileName(path: string): string {
  const name = path.replaceAll("\\", "/").split("/").at(-1) || "file";
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

function messageFileDirectory(body: string): FileDirectoryContext | null {
  const contexts = new Map<string, FileDirectoryContext>();
  for (const match of body.matchAll(/`([^`\r\n]+[/\\])`/gu)) {
    const path = match[1]?.trim();
    if (!path) continue;
    const shared = sharedFileTarget(`${path}file`);
    const workspace = workspaceFileTarget(`${path}file`);
    if (shared) contexts.set(path, { path, kind: "shared" });
    else if (workspace) contexts.set(path, { path, kind: "workspace" });
  }
  return contexts.size === 1 ? (contexts.values().next().value ?? null) : null;
}

function mentionedFileTarget(value: string, directory: FileDirectoryContext | null): FileDirectoryContext | null {
  const path = value.trim();
  if (!isFileMention(path)) return null;
  const shared = sharedFileTarget(path);
  if (shared) return { path: shared, kind: "shared" };
  if (/^(?:~[/\\]|[/\\]|[A-Za-z]:[/\\])/u.test(path)) {
    const workspace = workspaceFileTarget(path);
    return workspace ? { path: workspace, kind: "workspace" } : null;
  }
  if (!directory) return { path, kind: "workspace" };
  const separator = directory.path.includes("\\") && !directory.path.includes("/") ? "\\" : "/";
  return {
    path: `${directory.path.replace(/[/\\]+$/u, "")}${separator}${path}`,
    kind: directory.kind,
  };
}

function isFileMention(value: string): boolean {
  if (!value || /[\0\r\n]/u.test(value) || /[/\\]$/u.test(value)) return false;
  const name = workspaceFileName(value);
  if (/^(Dockerfile|Makefile|\.gitignore)$/iu.test(name)) return true;
  return /\.(?:avif|bash|c|conf|cpp|cs|css|csv|env|fish|gif|go|h|hpp|html?|ini|java|jpe?g|jsx?|json|kt|kts|log|markdown|md|pdf|php|png|ps1|py|rb|rs|scala|sh|sql|swift|toml|tsx?|txt|webp|xml|ya?ml|zsh)$/iu.test(
    name,
  );
}
