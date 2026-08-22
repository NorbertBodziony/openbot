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
};

type MarkdownContentProps = Omit<MarkdownMessageTextProps, "body" | "showCitationFooter" | "streaming">;

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
    attachments: props.attachments,
    citations: props.citations,
    onSelectAgent: props.onSelectAgent,
    onOpenLink: props.onOpenLink,
    onOpenAttachment: props.onOpenAttachment,
    onOpenSharedFile: props.onOpenSharedFile,
    onOpenWorkspaceFile: props.onOpenWorkspaceFile,
  });

  return (
    <>
      <MarkdownBlocks tokens={tokens()} content={contentProps()} streaming={props.streaming} />
      <Show when={props.showCitationFooter !== false && (props.citations?.length ?? 0) > 0}>
        <RichMessageText {...contentProps()} body="" />
      </Show>
    </>
  );
}

export function MarkdownInlineText(props: Omit<MarkdownMessageTextProps, "showCitationFooter" | "streaming">) {
  const tokens = createMemo(() => marked.Lexer.lexInline(props.body, { breaks: true, gfm: true }));
  const contentProps = (): MarkdownContentProps => ({
    bots: props.bots,
    attachments: props.attachments,
    citations: props.citations,
    onSelectAgent: props.onSelectAgent,
    onOpenLink: props.onOpenLink,
    onOpenAttachment: props.onOpenAttachment,
    onOpenSharedFile: props.onOpenSharedFile,
    onOpenWorkspaceFile: props.onOpenWorkspaceFile,
  });
  return <MarkdownInline tokens={tokens()} content={contentProps()} />;
}

function MarkdownBlocks(props: { tokens: Token[]; content: MarkdownContentProps; streaming?: boolean }) {
  const tokens = createMemo(() => props.tokens);
  return (
    <For each={tokens()}>
      {(token) => <MarkdownBlock token={token} content={props.content} streaming={props.streaming} />}
    </For>
  );
}

function MarkdownBlock(props: { token: Token; content: MarkdownContentProps; streaming?: boolean }) {
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
          <MarkdownInline tokens={token.tokens} content={props.content} />
        </Dynamic>
      );
    }
    case "paragraph": {
      if (!tokenIs(token, "paragraph")) return token.raw;
      return (
        <p>
          <MarkdownInline tokens={token.tokens} content={props.content} />
        </p>
      );
    }
    case "blockquote": {
      if (!tokenIs(token, "blockquote")) return token.raw;
      return (
        <blockquote>
          <MarkdownBlocks tokens={token.tokens} content={props.content} streaming={props.streaming} />
        </blockquote>
      );
    }
    case "list": {
      if (!tokenIs(token, "list")) return token.raw;
      return <MarkdownList token={token} content={props.content} streaming={props.streaming} />;
    }
    case "code": {
      if (!tokenIs(token, "code")) return token.raw;
      const language = token.lang?.trim().split(/\s+/u)[0] ?? "";
      return <CodeBlock block={{ type: "code", code: token.text, language }} streaming={props.streaming === true} />;
    }
    case "table": {
      if (!tokenIs(token, "table")) return token.raw;
      return <MarkdownTable token={token} content={props.content} />;
    }
    case "hr":
      return <hr />;
    case "html":
      return <span class="message-markdown-raw-html">{token.raw}</span>;
    case "text": {
      if (!tokenIs(token, "text")) return token.raw;
      return token.tokens ? (
        <MarkdownInline tokens={token.tokens} content={props.content} />
      ) : (
        <RichText body={token.text} content={props.content} />
      );
    }
    default:
      return <RichText body={token.raw} content={props.content} />;
  }
}

function MarkdownList(props: { token: Tokens.List; content: MarkdownContentProps; streaming?: boolean }) {
  const items = createMemo(() => props.token.items);
  const list = () => (
    <For each={items()}>
      {(item) => (
        <li class={item.task ? "message-markdown-task" : undefined}>
          <Show when={item.task}>
            <Checkbox
              class="message-markdown-checkbox"
              checked={item.checked === true}
              disabled
              aria-label={item.text}
            />
          </Show>
          <MarkdownBlocks
            tokens={item.tokens.filter((child) => child.type !== "checkbox")}
            content={props.content}
            streaming={props.streaming}
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

function MarkdownTable(props: { token: Tokens.Table; content: MarkdownContentProps }) {
  const headers = createMemo(() => props.token.header);
  const rows = createMemo(() => props.token.rows);
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
            {(row) => (
              <tr>
                <For each={row}>
                  {(cell) => (
                    <td data-align={cell.align ?? "left"}>
                      <MarkdownInline tokens={cell.tokens} content={props.content} />
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

function MarkdownInline(props: { tokens: Token[]; content: MarkdownContentProps }) {
  const tokens = createMemo(() => props.tokens);
  return (
    <For each={tokens()}>
      {(token) => {
        switch (token.type) {
          case "strong":
            if (!tokenIs(token, "strong")) return token.raw;
            return (
              <strong>
                <MarkdownInline tokens={token.tokens} content={props.content} />
              </strong>
            );
          case "em":
            if (!tokenIs(token, "em")) return token.raw;
            return (
              <em>
                <MarkdownInline tokens={token.tokens} content={props.content} />
              </em>
            );
          case "del":
            if (!tokenIs(token, "del")) return token.raw;
            return (
              <del>
                <MarkdownInline tokens={token.tokens} content={props.content} />
              </del>
            );
          case "codespan": {
            if (!tokenIs(token, "codespan")) return token.raw;
            return <code>{token.text}</code>;
          }
          case "br":
            return <br />;
          case "link": {
            if (!tokenIs(token, "link")) return token.raw;
            const url = safeBrowserUrl(token.href);
            const workspacePath = workspaceFileTarget(token.href);
            return url ? (
              <MessageLink url={url} title={token.title} onOpenLink={props.content.onOpenLink}>
                {token.text === token.href ? (
                  token.text
                ) : (
                  <MarkdownInline tokens={token.tokens} content={props.content} />
                )}
              </MessageLink>
            ) : workspacePath && props.content.onOpenWorkspaceFile ? (
              <WorkspaceFileLink
                path={workspacePath}
                label={token.text}
                onOpenWorkspaceFile={props.content.onOpenWorkspaceFile}
              />
            ) : (
              <RichText body={token.text} content={props.content} />
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
              <RichText body={token.text || token.raw} content={props.content} />
            );
          }
          case "html":
            return token.raw;
          case "escape": {
            if (!tokenIs(token, "escape")) return token.raw;
            return <RichText body={token.text} content={props.content} />;
          }
          case "text": {
            if (!tokenIs(token, "text")) return token.raw;
            return token.tokens ? (
              <MarkdownInline tokens={token.tokens} content={props.content} />
            ) : (
              <RichText body={token.text} content={props.content} />
            );
          }
          case "checkbox":
            return null;
          default:
            return <RichText body={token.raw} content={props.content} />;
        }
      }}
    </For>
  );
}

function RichText(props: { body: string; content: MarkdownContentProps }) {
  return <RichMessageText {...props.content} body={props.body} showCitationFooter={false} />;
}

function WorkspaceFileLink(props: { path: string; label: string; onOpenWorkspaceFile: (path: string) => void }) {
  const name = workspaceFileName(props.path);
  return (
    <Button
      type="button"
      class="inline-file-reference"
      data-file-tone={attachmentReferenceTone(name)}
      aria-label={`Open workspace file ${name}`}
      title={props.path}
      onClick={() => props.onOpenWorkspaceFile(props.path)}
    >
      <AttachmentReferenceVisual name={name} />
      <span class="inline-file-reference-name">{props.label || name}</span>
    </Button>
  );
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
