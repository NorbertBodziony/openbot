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
// literal on either side - every reference goes through IPC_CHANNELS. Two tests
// below keep that true rather than assumed: one rejects a known call that takes
// a string channel, which the scan would otherwise not see at all, and one
// rejects an IPC_CHANNELS reference the scan cannot attribute to a known call.

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

const mainSources = sourceFilesUnder("src/main");
const preloadSources = ["src/preload/index.ts"];

const mainReferences = collectReferences(mainSources);
const preloadReferences = collectReferences(preloadSources);

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

  // The scan finds channels through IPC_CHANNELS references, so a call that
  // names its channel as a string instead is not an unattributed reference -
  // it is no reference at all, and every assertion below stays green while an
  // undeclared handler sits on the trust boundary. This is what makes the
  // "never written as a literal" claim at the top of this file true rather
  // than merely believed.
  it("names every channel through IPC_CHANNELS rather than a string literal", () => {
    const literals = [...literalChannelCalls(mainSources), ...literalChannelCalls(preloadSources)];

    expect(literals).toEqual([]);
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

  // The assertions above compare sets, which is right for sends and
  // subscriptions - a channel may have many of each - but wrong for handlers.
  // ipcMain.handle throws on a second registration for the same channel, so a
  // channel registered in two files crashes the app on every launch while
  // deduplication leaves every set comparison green.
  it("registers each request channel exactly once in the main process", () => {
    const registrations = new Map<string, string[]>();
    for (const reference of mainReferences) {
      if (!MAIN_HANDLER_CALLEES.includes(reference.callee)) continue;
      registrations.set(reference.channel, [
        ...(registrations.get(reference.channel) ?? []),
        `${reference.file} ${reference.callee}`,
      ]);
    }

    const duplicated = [...registrations]
      .filter(([, sites]) => sites.length > 1)
      .map(([channel, sites]) => `${channel}: ${sites.join(", ")}`)
      .sort();

    expect(duplicated).toEqual([]);
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

// Every call shape the scan knows, with the position its channel argument sits
// in - first for all of them except sendToRenderer, where it follows the window.
const CHANNEL_ARGUMENT_POSITION: ReadonlyMap<string, number> = new Map([
  ...[
    ...MAIN_HANDLER_CALLEES,
    ...PRELOAD_INVOKE_CALLEES,
    ...PRELOAD_SUBSCRIBE_CALLEES,
    ...PRELOAD_UNSUBSCRIBE_CALLEES,
  ].map((callee): readonly [string, number] => [callee, 0]),
  ...MAIN_SEND_CALLEES.map((callee): readonly [string, number] => [callee, 1]),
]);

// Reports every known call whose channel argument is a string rather than an
// IPC_CHANNELS reference. A function declaration is not a call site here: its
// parameter reads as `channel: string`, which does not open with a quote.
function literalChannelCalls(files: readonly string[]): readonly string[] {
  const found: string[] = [];
  for (const file of files) {
    const source = withoutCommentsAndLiterals(readFileSync(join(repositoryRoot, file), "utf8"));
    for (const [callee, position] of CHANNEL_ARGUMENT_POSITION) {
      const pattern = new RegExp(`(?<![A-Za-z0-9_$.])${callee.replaceAll(".", "\\.")}\\s*\\(`, "g");
      for (const match of source.matchAll(pattern)) {
        const argument = argumentAt(source, match.index + match[0].length, position);
        if (argument !== null && /^["'`]/.test(argument)) found.push(`${file}: ${callee} takes a string channel`);
      }
    }
  }
  return found.sort();
}

// Reads the argument at `position` from a call whose opening parenthesis has
// already been passed, splitting on the commas that sit at the call's own
// nesting depth so a nested call or object literal is not mistaken for a
// separator.
function argumentAt(source: string, start: number, position: number): string | null {
  let depth = 0;
  let index = start;
  let argumentStart = start;
  let remaining = position;
  while (index < source.length) {
    const character = source[index];
    if (character === "(" || character === "[" || character === "{") depth += 1;
    else if (character === ")" && depth === 0) break;
    else if (character === ")" || character === "]" || character === "}") depth -= 1;
    else if (character === "," && depth === 0) {
      if (remaining === 0) return source.slice(argumentStart, index).trim();
      remaining -= 1;
      argumentStart = index + 1;
    }
    index += 1;
  }
  return remaining === 0 ? source.slice(argumentStart, index).trim() : null;
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
