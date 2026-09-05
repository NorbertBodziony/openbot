import { type ShjLanguage, type ShjToken, tokenize } from "@speed-highlight/core";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { Button, Check, Copy } from "../../components/ui";
import type { MessageCodeBlock } from "./DataTable";

interface CodeToken {
  text: string;
  type?: ShjToken;
}

type CodeLine = CodeToken[];

const LANGUAGE_ALIASES: Record<string, ShjLanguage> = {
  assembly: "asm",
  shell: "bash",
  sh: "bash",
  zsh: "bash",
  cpp: "c",
  cxx: "c",
  dockerfile: "docker",
  golang: "go",
  htaccess: "http",
  javascript: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  markdown: "md",
  perl: "pl",
  plaintext: "plain",
  text: "plain",
  txt: "plain",
  python: "py",
  rust: "rs",
  scss: "css",
  typescript: "ts",
  tsx: "ts",
  svg: "xml",
  yml: "yaml",
};

const SUPPORTED_LANGUAGES = new Set<string>([
  "asm",
  "bash",
  "bf",
  "c",
  "css",
  "csv",
  "diff",
  "docker",
  "git",
  "go",
  "html",
  "http",
  "ini",
  "java",
  "js",
  "jsdoc",
  "json",
  "leanpub-md",
  "log",
  "lua",
  "make",
  "md",
  "pl",
  "plain",
  "py",
  "regex",
  "rs",
  "sql",
  "todo",
  "toml",
  "ts",
  "uri",
  "xml",
  "yaml",
]);

const LANGUAGE_LABELS: Partial<Record<ShjLanguage, string>> = {
  asm: "Assembly",
  bash: "Shell",
  c: "C",
  css: "CSS",
  csv: "CSV",
  diff: "Diff",
  docker: "Dockerfile",
  go: "Go",
  html: "HTML",
  http: "HTTP",
  ini: "INI",
  java: "Java",
  js: "JavaScript",
  jsdoc: "JSDoc",
  json: "JSON",
  lua: "Lua",
  make: "Makefile",
  md: "Markdown",
  plain: "Code",
  py: "Python",
  regex: "Regular expression",
  rs: "Rust",
  sql: "SQL",
  toml: "TOML",
  ts: "TypeScript",
  xml: "XML",
  yaml: "YAML",
};

export function CodeBlock(props: { block: MessageCodeBlock; streaming?: boolean }) {
  const [lines, setLines] = createSignal<CodeLine[]>(plainCodeLines(props.block.code));
  const [copied, setCopied] = createSignal(false);
  let highlightRun = 0;
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;

  const language = () => codeLanguage(props.block.language);
  const languageLabel = () => codeLanguageLabel(props.block.language);

  createEffect(
    () => ({ code: props.block.code, language: language() }),
    ({ code, language: selectedLanguage }) => {
      const run = ++highlightRun;
      setLines(plainCodeLines(code));
      if (selectedLanguage === "plain") return;

      void highlightedCodeLines(code, selectedLanguage).then((highlightedLines) => {
        if (run === highlightRun) setLines(highlightedLines);
      });
    },
  );

  onCleanup(() => {
    highlightRun += 1;
    if (copiedTimer) clearTimeout(copiedTimer);
  });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.block.code);
      setCopied(true);
      if (copiedTimer) clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section class="message-code-block" aria-label={`${languageLabel()} code block`}>
      <header class="message-code-header">
        <div class="message-code-heading">
          <Show when={props.block.filename}>
            {(filename) => <span class="message-code-filename">{filename()}</span>}
          </Show>
          <span class="message-code-language">{languageLabel()}</span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          class="message-code-copy"
          aria-label={copied() ? "Code copied" : "Copy code"}
          onClick={() => void copy()}
        >
          <span class="message-code-copy-icons" aria-hidden="true">
            <span data-visible={!copied() ? "true" : undefined}>
              <Copy />
            </span>
            <span data-visible={copied() ? "true" : undefined}>
              <Check />
            </span>
          </span>
          <span>{copied() ? "Copied" : "Copy"}</span>
        </Button>
      </header>
      <pre class="message-code-scroll" tabindex="0">
        <code>
          <For each={lines()}>
            {(line, lineIndex) => (
              <span class="message-code-line">
                <span class="message-code-line-number" aria-hidden="true">
                  {lineIndex() + 1}
                </span>
                <span class="message-code-line-source">
                  <For each={line}>{(token) => <span data-code-token={token.type}>{token.text}</span>}</For>
                  <Show when={props.streaming && lineIndex() === lines().length - 1}>
                    <span class="message-code-caret" aria-hidden="true" />
                  </Show>
                </span>
              </span>
            )}
          </For>
        </code>
      </pre>
    </section>
  );
}

export function codeLanguage(language: string): ShjLanguage {
  const normalized = language.trim().toLowerCase();
  if (!normalized) return "plain";
  const alias = LANGUAGE_ALIASES[normalized];
  if (alias) return alias;
  return isSupportedLanguage(normalized) ? normalized : "plain";
}

function isSupportedLanguage(language: string): language is ShjLanguage {
  return SUPPORTED_LANGUAGES.has(language);
}

export function codeLanguageLabel(language: string): string {
  const normalized = codeLanguage(language);
  if (normalized !== "plain") return LANGUAGE_LABELS[normalized] ?? normalized.toUpperCase();
  const original = language.trim();
  return original ? original.toUpperCase() : "Code";
}

function plainCodeLines(code: string): CodeLine[] {
  return code.split("\n").map((line) => [{ text: line }]);
}

async function highlightedCodeLines(code: string, language: ShjLanguage): Promise<CodeLine[]> {
  const lines: CodeLine[] = [[]];
  try {
    await tokenize(code, language, (text, type) => {
      const fragments = text.split("\n");
      for (const [index, fragment] of fragments.entries()) {
        if (fragment) lines.at(-1)?.push({ text: fragment, type });
        if (index < fragments.length - 1) lines.push([]);
      }
    });
    return lines;
  } catch {
    return plainCodeLines(code);
  }
}
