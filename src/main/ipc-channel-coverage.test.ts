// @vitest-environment node

// One channel list, two hand-written mirrors: the main process registers
// handlers, the preload calls them, and only the type checker links the two.
// It cannot link them completely - a channel the preload invokes with no main
// handler type-checks and rejects at runtime, and a handler nobody calls is
// dead trust-boundary surface. This test is that link.
//
// Verification is static because neither side can be imported: src/main/index.ts
// calls app.setPath, app.enableSandbox and protocol.registerSchemesAsPrivileged
// at module scope and does not export its registrations, and src/preload/index.ts
// calls contextBridge.exposeInMainWorld at module scope and exports nothing.
// Reading the sources is safe here because a channel name is never written as a
// literal on either side - every reference goes through IPC_CHANNELS - and the
// "attributes every reference" test below is what keeps that true.

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { IPC_CHANNELS } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");

// The channel is the first argument to each of these, except sendToRenderer,
// where it follows the target window.
const MAIN_HANDLER_CALLEES = ["handleTrusted", "handleTrustedWithEvent"];
const MAIN_SEND_CALLEES = ["sendToRenderer"];
const PRELOAD_INVOKE_CALLEES = ["ipcRenderer.invoke", "invokeAgent", "invokeAgentForServer"];
const PRELOAD_SUBSCRIBE_CALLEES = ["ipcRenderer.on", "ipcRenderer.once"];
const PRELOAD_UNSUBSCRIBE_CALLEES = ["ipcRenderer.removeListener", "ipcRenderer.off"];

const declaredChannels = Object.keys(IPC_CHANNELS).sort();

const mainReferences = collectReferences(sourceFilesUnder("src/main"));
const preloadReferences = collectReferences(["src/preload/index.ts"]);

const handled = channelsCalledBy(mainReferences, MAIN_HANDLER_CALLEES);
const sent = channelsCalledBy(mainReferences, MAIN_SEND_CALLEES);
const invoked = channelsCalledBy(preloadReferences, PRELOAD_INVOKE_CALLEES);
const subscribed = channelsCalledBy(preloadReferences, PRELOAD_SUBSCRIBE_CALLEES);
const unsubscribed = channelsCalledBy(preloadReferences, PRELOAD_UNSUBSCRIBE_CALLEES);

describe("IPC channel coverage", () => {
  // A pattern that matches nothing is green and enforces nothing. This runs
  // first because every assertion below is only as complete as the scan: a new
  // helper, or a call shape the scan does not know, would otherwise quietly
  // shrink the sets being compared instead of failing.
  it("attributes every IPC_CHANNELS reference in the main process and the preload to a known call", () => {
    const known = new Set([
      ...MAIN_HANDLER_CALLEES,
      ...MAIN_SEND_CALLEES,
      ...PRELOAD_INVOKE_CALLEES,
      ...PRELOAD_SUBSCRIBE_CALLEES,
      ...PRELOAD_UNSUBSCRIBE_CALLEES,
    ]);
    const unknown = [...mainReferences, ...preloadReferences]
      .filter((reference) => !known.has(reference.callee))
      .map((reference) => `${reference.file}: ${reference.callee}(IPC_CHANNELS.${reference.channel})`);

    expect(unknown).toEqual([]);
  });

  it("registers or sends every declared channel in the main process, and nothing it does not declare", () => {
    expect([...handled, ...sent].sort()).toEqual(declaredChannels);
  });

  it("invokes or subscribes to every declared channel in the preload, and nothing it does not declare", () => {
    expect([...invoked, ...subscribed].sort()).toEqual(declaredChannels);
  });

  it("backs every channel the preload invokes with a registered main handler", () => {
    expect(invoked).toEqual(handled);
  });

  it("gives every event channel the preload listens for a main process sender", () => {
    expect(subscribed).toEqual(sent);
  });

  it("only removes listeners for channels the preload subscribes to", () => {
    expect(unsubscribed.filter((channel) => !subscribed.includes(channel))).toEqual([]);
  });
});

interface ChannelReference {
  readonly file: string;
  readonly callee: string;
  readonly channel: string;
}

function sourceFilesUnder(directory: string): readonly string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(repositoryRoot, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...sourceFilesUnder(path));
    else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) files.push(path);
  }
  return files;
}

function collectReferences(files: readonly string[]): readonly ChannelReference[] {
  const references: ChannelReference[] = [];
  for (const file of files) {
    const source = withoutCommentsAndLiterals(readFileSync(join(repositoryRoot, file), "utf8"));
    for (const match of source.matchAll(/IPC_CHANNELS\.([A-Za-z0-9_]+)/g)) {
      references.push({
        file,
        callee: calleeBefore(source, match.index) ?? "(no enclosing call)",
        channel: match[1] ?? "",
      });
    }
  }
  return references;
}

function channelsCalledBy(references: readonly ChannelReference[], callees: readonly string[]): readonly string[] {
  const channels = new Set(
    references.filter((reference) => callees.includes(reference.callee)).map((reference) => reference.channel),
  );
  return [...channels].sort();
}

// Walks back from a reference to the call it sits in, skipping balanced
// parentheses so an argument of its own is not mistaken for the callee, and
// giving up at a statement boundary so a reference outside any call reads as
// unattributed rather than borrowing an unrelated name.
function calleeBefore(source: string, index: number): string | null {
  let depth = 0;
  let position = index - 1;
  while (position >= 0) {
    const character = source[position];
    if (character === ")") depth += 1;
    else if (character === "(") {
      if (depth === 0) break;
      depth -= 1;
    } else if (depth === 0 && (character === ";" || character === "{" || character === "}")) return null;
    position -= 1;
  }
  if (position < 0) return null;

  let start = position - 1;
  while (start >= 0 && /\s/.test(source[start] ?? "")) start -= 1;
  const end = start + 1;
  while (start >= 0 && /[A-Za-z0-9_$.]/.test(source[start] ?? "")) start -= 1;
  return source.slice(start + 1, end) || null;
}

// Blanks comments and the insides of string, template and regular expression
// literals, keeping every other character at its original offset so the walk
// above still lines up. A commented-out registration must not read as a
// registration.
function withoutCommentsAndLiterals(source: string): string {
  const characters = [...source];
  let index = 0;

  const blankUntil = (isEnd: (position: number) => boolean, escapes: boolean): void => {
    while (index < characters.length && !isEnd(index)) {
      if (escapes && characters[index] === "\\") {
        characters[index] = " ";
        index += 1;
      }
      if (index < characters.length && characters[index] !== "\n") characters[index] = " ";
      index += 1;
    }
  };

  while (index < characters.length) {
    const character = characters[index];
    const next = characters[index + 1];

    if (character === "/" && next === "/") {
      index += 2;
      blankUntil((position) => characters[position] === "\n", false);
      continue;
    }
    if (character === "/" && next === "*") {
      characters[index] = " ";
      characters[index + 1] = " ";
      index += 2;
      blankUntil((position) => characters[position] === "*" && characters[position + 1] === "/", false);
      if (index < characters.length) {
        characters[index] = " ";
        characters[index + 1] = " ";
        index += 2;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      index += 1;
      blankUntil((position) => characters[position] === character, true);
      index += 1;
      continue;
    }
    if (character === "/" && startsRegularExpression(characters, index)) {
      index += 1;
      blankUntil((position) => characters[position] === "/", true);
      index += 1;
      continue;
    }
    index += 1;
  }

  return characters.join("");
}

// A slash opens a regular expression only where a value may start; after a
// value it is division. Only the operators that actually precede a literal in
// these files need to be recognised, and a wrong guess surfaces as an
// unattributed reference rather than a silent miss.
function startsRegularExpression(characters: readonly string[], index: number): boolean {
  let position = index - 1;
  while (position >= 0 && /\s/.test(characters[position] ?? "")) position -= 1;
  const previous = characters[position];
  return previous === undefined || "(,=:[!&|?{};+-*%~^".includes(previous);
}
