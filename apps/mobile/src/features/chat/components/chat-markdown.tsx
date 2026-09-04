import * as Linking from "expo-linking";
import { Typography } from "heroui-native";
import { useThemeColor } from "heroui-native/hooks";
import { marked, type Token, type Tokens } from "marked";
import { Fragment, memo, type ReactNode, useMemo } from "react";
import { Alert, type ColorValue, ScrollView, type TextStyle, View } from "react-native";
import { ChatLinkIcon } from "@/features/chat/components/chat-link-icon";
import { StreamingTailText } from "@/features/chat/components/streaming-tail-text";
import { useStreamingText } from "@/features/chat/components/use-streaming-text";

interface MarkdownTokenByType {
  paragraph: Tokens.Paragraph;
  heading: Tokens.Heading;
  blockquote: Tokens.Blockquote;
  list: Tokens.List;
  code: Tokens.Code;
  table: Tokens.Table;
  text: Tokens.Text;
  escape: Tokens.Escape;
  strong: Tokens.Strong;
  em: Tokens.Em;
  del: Tokens.Del;
  codespan: Tokens.Codespan;
  link: Tokens.Link;
  image: Tokens.Image;
}

// Marked's public Token union includes extension tokens; narrow its built-in tokens here.
function tokenIs<K extends keyof MarkdownTokenByType>(token: Token, type: K): token is MarkdownTokenByType[K] {
  return token.type === type;
}

interface TextPresentation {
  type: "body" | "body-sm" | "h4" | "h5";
  style: TextStyle;
  codeColor: ColorValue;
  animateTail: boolean;
}

function webLink(href: string): string | null {
  try {
    const url = new URL(href);
    return ["https:", "http:", "mailto:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

// Source positions remain stable as the last token grows during streaming.
function sourceEntries<T>(values: T[], source: (value: T) => string) {
  let offset = 0;
  return values.map((value) => {
    const entry = { value, offset };
    offset += source(value).length + 1;
    return entry;
  });
}

function CodeSpan({ text, presentation }: { text: string; presentation: TextPresentation }) {
  return (
    <View
      collapsable={false}
      className={`max-w-full self-start rounded-xl bg-control px-1 ${presentation.type === "body-sm" ? "py-px" : "py-0.5"}`}
    >
      <Typography.Code
        selectable
        className={presentation.type === "body-sm" ? "bg-transparent p-0 text-xs leading-4" : "bg-transparent p-0"}
        style={{ ...presentation.style, color: presentation.codeColor }}
      >
        {text}
      </Typography.Code>
    </View>
  );
}

function inline(tokens: Token[], parentPresentation: TextPresentation): ReactNode {
  const lastToken = tokens.findLast((token) => token.type !== "br");
  return sourceEntries(tokens, (token) => token.raw).map(({ value: token, offset }) => {
    const presentation = { ...parentPresentation, animateTail: parentPresentation.animateTail && token === lastToken };
    if (token.type === "br") return "\n";
    if (tokenIs(token, "text")) {
      if (token.tokens) return inline(token.tokens, presentation);
      return presentation.animateTail ? (
        <StreamingTailText key={offset} body={token.text} type={presentation.type} style={presentation.style} />
      ) : (
        token.text
      );
    }
    if (tokenIs(token, "escape")) return token.text;
    if (tokenIs(token, "codespan")) {
      return <CodeSpan key={offset} text={token.text} presentation={presentation} />;
    }
    if (tokenIs(token, "strong") || tokenIs(token, "em") || tokenIs(token, "del")) {
      const style: TextStyle = {
        ...presentation.style,
        ...(token.type === "strong"
          ? { fontWeight: "700" }
          : token.type === "em"
            ? { fontStyle: "italic" }
            : { textDecorationLine: "line-through" }),
      };
      return (
        <Typography key={offset} type={presentation.type} style={style}>
          {inline(token.tokens, { ...presentation, style })}
        </Typography>
      );
    }
    if (tokenIs(token, "link") || tokenIs(token, "image")) {
      const url = webLink(token.href);
      const label = tokenIs(token, "image") ? token.text || "Image" : inline(token.tokens, presentation);
      if (!url) return <Fragment key={offset}>{label}</Fragment>;
      return (
        <Typography
          key={offset}
          type={presentation.type}
          style={{ ...presentation.style, textDecorationLine: "underline" }}
          accessibilityRole="link"
          accessibilityHint={url}
          onPress={() =>
            void Linking.openURL(url).catch(() =>
              Alert.alert("Couldn’t open link", "You can select and copy the link instead."),
            )
          }
        >
          {tokenIs(token, "link") ? (
            <>
              <ChatLinkIcon url={url} color={presentation.style.color} compact={presentation.type === "body-sm"} />
              {"\u00a0"}
            </>
          ) : null}
          {label}
        </Typography>
      );
    }
    // HTML remains inert text; Markdown images are opened only after an explicit tap.
    return token.raw;
  });
}

function ListParagraph({ tokens, presentation }: { tokens: Token[]; presentation: TextPresentation }) {
  const lines: Token[][][] = [[[]]];
  for (const token of tokens) {
    const line = lines[lines.length - 1];
    if (token.type === "br") {
      lines.push([[]]);
    } else if (tokenIs(token, "codespan")) {
      line.push([token], []);
    } else {
      line[line.length - 1].push(token);
    }
  }
  const source = (run: Token[]) => run.map((token) => token.raw).join("");
  return (
    <View className="min-w-0 gap-1">
      {sourceEntries(lines, (line) => line.map(source).join("")).map(({ value: line, offset: lineOffset }) => (
        // Multiline chips must participate in flex layout, not sit inside a fixed-height native text line.
        <View key={lineOffset} className="min-w-0 flex-row flex-wrap items-center gap-y-1">
          {sourceEntries(line, source).map(({ value: run, offset }) => {
            if (!run.length) return null;
            const token = run[0];
            if (tokenIs(token, "codespan")) {
              return <CodeSpan key={offset} text={token.text} presentation={presentation} />;
            }
            return (
              <Typography
                key={offset}
                selectable
                className="max-w-full"
                type={presentation.type}
                style={presentation.style}
              >
                {inline(run, {
                  ...presentation,
                  animateTail: presentation.animateTail && run.at(-1) === tokens.at(-1),
                })}
              </Typography>
            );
          })}
        </View>
      ))}
    </View>
  );
}

function MarkdownBlocks({
  tokens,
  presentation: parentPresentation,
  inList = false,
}: {
  tokens: Token[];
  presentation: TextPresentation;
  inList?: boolean;
}) {
  const lastToken = tokens.findLast((token) => token.type !== "space" && token.type !== "def");
  return (
    <View className="min-w-0 gap-3">
      {sourceEntries(tokens, (token) => token.raw).map(({ value: token, offset }) => {
        const presentation = {
          ...parentPresentation,
          animateTail: parentPresentation.animateTail && token === lastToken,
        };
        if (token.type === "space" || token.type === "def") return null;
        if (tokenIs(token, "paragraph") || tokenIs(token, "text")) {
          if (inList && token.tokens?.some((child) => tokenIs(child, "codespan"))) {
            return <ListParagraph key={offset} tokens={token.tokens} presentation={presentation} />;
          }
          return (
            <Typography key={offset} selectable type={presentation.type} style={presentation.style}>
              {token.tokens ? inline(token.tokens, presentation) : token.text}
            </Typography>
          );
        }
        if (tokenIs(token, "heading")) {
          const heading: TextPresentation = { ...presentation, type: token.depth <= 2 ? "h4" : "h5" };
          return (
            <Typography.Heading
              key={offset}
              selectable
              type={heading.type === "h4" ? "h4" : "h5"}
              style={presentation.style}
            >
              {inline(token.tokens, heading)}
            </Typography.Heading>
          );
        }
        if (tokenIs(token, "code")) {
          return (
            <ScrollView
              key={offset}
              horizontal
              alwaysBounceHorizontal={false}
              className="rounded-xl bg-control"
              contentContainerStyle={{ padding: 10 }}
            >
              <Typography.Code
                selectable
                className="bg-transparent p-0"
                style={{ ...presentation.style, color: presentation.codeColor }}
              >
                {token.text}
              </Typography.Code>
            </ScrollView>
          );
        }
        if (tokenIs(token, "blockquote")) {
          return (
            <View key={offset} className="border-l-2 border-separator pl-3">
              <MarkdownBlocks tokens={token.tokens} presentation={presentation} inList={inList} />
            </View>
          );
        }
        if (tokenIs(token, "list")) {
          return (
            <View key={offset} className="gap-2">
              {sourceEntries(token.items, (item) => item.raw).map(({ value: item, offset: itemOffset }, itemIndex) => (
                <View key={itemOffset} className="flex-row items-start gap-2">
                  <Typography type={presentation.type} style={presentation.style}>
                    {item.task
                      ? item.checked
                        ? "☑"
                        : "☐"
                      : token.ordered
                        ? `${Number(token.start) + itemIndex}.`
                        : "•"}
                  </Typography>
                  <View className="min-w-0 shrink">
                    <MarkdownBlocks
                      tokens={item.tokens}
                      inList
                      presentation={{
                        ...presentation,
                        animateTail: presentation.animateTail && item === token.items.at(-1),
                      }}
                    />
                  </View>
                </View>
              ))}
            </View>
          );
        }
        if (tokenIs(token, "table")) {
          return (
            <ScrollView key={offset} horizontal alwaysBounceHorizontal={false}>
              <View>
                {sourceEntries([token.header, ...token.rows], (row) => row.map((cell) => cell.text).join("|")).map(
                  ({ value: row, offset: rowOffset }) => (
                    <View key={rowOffset} className="flex-row border-b border-separator">
                      {sourceEntries(row, (cell) => cell.text).map(({ value: cell, offset: cellOffset }) => (
                        <View key={cellOffset} className="w-44 px-2 py-2">
                          <Typography
                            selectable
                            type={presentation.type}
                            style={{
                              ...presentation.style,
                              textAlign: cell.align ?? "left",
                              fontWeight: cell.header ? "600" : "400",
                            }}
                          >
                            {inline(cell.tokens, {
                              ...presentation,
                              animateTail: presentation.animateTail && row === token.rows.at(-1) && cell === row.at(-1),
                            })}
                          </Typography>
                        </View>
                      ))}
                    </View>
                  ),
                )}
              </View>
            </ScrollView>
          );
        }
        if (token.type === "hr") return <View key={offset} className="h-px bg-separator" />;
        return (
          <Typography key={offset} selectable type={presentation.type} style={presentation.style}>
            {token.raw}
          </Typography>
        );
      })}
    </View>
  );
}

export const ChatMarkdown = memo(function ChatMarkdown({
  body,
  color,
  compact = false,
  streaming = false,
  animateInitial = false,
  animationEnabled = true,
}: {
  body: string;
  color: ColorValue | undefined;
  compact?: boolean;
  streaming?: boolean;
  animateInitial?: boolean;
  animationEnabled?: boolean;
}) {
  const display = useStreamingText(body, streaming, animateInitial, animationEnabled);
  const tokens = useMemo(() => marked.lexer(display.body, { gfm: true, breaks: true }), [display.body]);
  const codeColor = useThemeColor("foreground");
  return (
    <MarkdownBlocks
      tokens={tokens}
      presentation={{
        type: compact ? "body-sm" : "body",
        style: { color: color ?? codeColor },
        codeColor,
        animateTail: display.animateTail,
      }}
    />
  );
});
