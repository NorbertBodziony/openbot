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
// below keep that true rather than assumed: one reads the channel argument of
// every known call and rejects anything but a direct IPC_CHANNELS reference, so
// a string or a variable cannot slip an endpoint past the scan, and one rejects
// an IPC_CHANNELS reference no known call reads.

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

// Two of the calls address a recipient before the channel: sendToRenderer takes
// the target window, invokeAgentForServer the server id.
const CHANNEL_AFTER_RECIPIENT = ["sendToRenderer", "invokeAgentForServer"];

// Every call shape the scan knows, with the position its channel argument sits in.
const CHANNEL_ARGUMENT_POSITION: ReadonlyMap<string, number> = new Map(
  [
    ...MAIN_HANDLER_CALLEES,
    ...MAIN_SEND_CALLEES,
    ...PRELOAD_INVOKE_CALLEES,
    ...PRELOAD_SUBSCRIBE_CALLEES,
    ...PRELOAD_UNSUBSCRIBE_CALLEES,
  ].map((callee): readonly [string, number] => [callee, CHANNEL_AFTER_RECIPIENT.includes(callee) ? 1 : 0]),
);

const CHANNEL_REFERENCE = /^IPC_CHANNELS\.([A-Za-z0-9_]+)$/;

const sources = new Map<string, string>();

const mainSources = sourceFilesUnder("src/main");
const preloadSources = ["src/preload/index.ts"];

// The preload's agent helpers take the channel as a parameter and pass it on,
// so the forwarding call names a variable by design. Their own call sites carry
// the IPC_CHANNELS reference and are what the scan checks, which is why the
// helpers are listed as callees above.
const FORWARDED_CHANNEL_ARGUMENTS: readonly string[] = [
  "src/preload/index.ts: invokeAgentForServer(channel)",
  "src/preload/index.ts: ipcRenderer.invoke(channel)",
];

const mainCalls = collectCalls(mainSources);
const preloadCalls = collectCalls(preloadSources);

const handled = channelsCalledBy(mainCalls, MAIN_HANDLER_CALLEES);
const sent = channelsCalledBy(mainCalls, MAIN_SEND_CALLEES);
const invoked = channelsCalledBy(preloadCalls, PRELOAD_INVOKE_CALLEES);
const subscribed = channelsCalledBy(preloadCalls, PRELOAD_SUBSCRIBE_CALLEES);
const unsubscribed = channelsCalledBy(preloadCalls, PRELOAD_UNSUBSCRIBE_CALLEES);

describe("IPC channel coverage", () => {
  // Every assertion below is only as complete as the scan, so these two run
  // first. This one reads each known call's channel argument and demands a
  // direct IPC_CHANNELS reference: a string names a channel the contract never
  // declared, and a variable hides the wire endpoint from the scan entirely.
  // Either way the call would contribute nothing to the sets compared below
  // while sitting on the trust boundary, so it fails here instead.
  it("names every channel through a direct IPC_CHANNELS reference", () => {
    const opaque = [...mainCalls, ...preloadCalls]
      .filter((call) => !CHANNEL_REFERENCE.test(call.argument))
      .map((call) => `${call.file}: ${call.callee}(${call.argument})`)
      .filter((site) => !FORWARDED_CHANNEL_ARGUMENTS.includes(site))
      .sort();

    expect(opaque).toEqual([]);
  });

  // The other half: a reference the scan does not read as a channel argument.
  // A new helper wrapping IPC_CHANNELS, or a reference sitting in a handler
  // body, would otherwise quietly shrink the compared sets rather than fail.
  it("reads every IPC_CHANNELS reference as the channel argument of a known call", () => {
    const stray = [...strayReferences(mainSources, mainCalls), ...strayReferences(preloadSources, preloadCalls)];

    expect(stray).toEqual([]);
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
    for (const call of mainCalls) {
      if (!MAIN_HANDLER_CALLEES.includes(call.callee)) continue;
      const channel = channelOf(call);
      if (channel === null) continue;
      registrations.set(channel, [...(registrations.get(channel) ?? []), `${call.file} ${call.callee}`]);
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

  // Everything above compares IPC_CHANNELS keys, but Electron sees the values.
  // Two keys carrying one wire string satisfy the exactly-once assertion, since
  // the keys differ, and still register two handlers for the same channel.
  it("gives every declared channel its own wire value", () => {
    const wireValues = new Map<string, string[]>();
    for (const [key, value] of Object.entries(IPC_CHANNELS)) {
      wireValues.set(value, [...(wireValues.get(value) ?? []), key]);
    }

    const shared = [...wireValues]
      .filter(([, keys]) => keys.length > 1)
      .map(([value, keys]) => `${value}: ${keys.join(", ")}`)
      .sort();

    expect(shared).toEqual([]);
  });

  it("only removes listeners for channels the preload subscribes to", () => {
    expect(unsubscribed.filter((channel) => !subscribed.includes(channel))).toEqual([]);
  });
});

// One occurrence of a known call, with the source text of its channel argument
// and the span that argument occupies. The span is what lets a reference be
// matched back to the call that reads it.
interface ChannelCall {
  readonly file: string;
  readonly callee: string;
  readonly argument: string;
  readonly start: number;
  readonly end: number;
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

function readSource(file: string): string {
  const cached = sources.get(file);
  if (cached !== undefined) return cached;
  const source = withoutCommentsAndLiterals(readFileSync(join(repositoryRoot, file), "utf8"));
  sources.set(file, source);
  return source;
}

// Reads each known call forwards from its own name to the argument in the
// channel position, rather than walking back from an IPC_CHANNELS reference to
// whatever call appears to enclose it. Only the forward direction sees a call
// whose channel is a variable or a string, and those are the calls that would
// otherwise leave the trust boundary unscanned. A `function` keyword before the
// name marks a declaration of the helper rather than a call to it.
function collectCalls(files: readonly string[]): readonly ChannelCall[] {
  const calls: ChannelCall[] = [];
  for (const file of files) {
    const source = readSource(file);
    for (const [callee, position] of CHANNEL_ARGUMENT_POSITION) {
      const pattern = new RegExp(`(?<![A-Za-z0-9_$.])${callee.replaceAll(".", "\\.")}\\s*\\(`, "g");
      for (const match of source.matchAll(pattern)) {
        if (/\bfunction\s*$/.test(source.slice(Math.max(0, match.index - 20), match.index))) continue;
        const span = argumentAt(source, match.index + match[0].length, position);
        if (span !== null) calls.push({ file, callee, ...span });
      }
    }
  }
  return calls;
}

// Reads the argument at `position` from a call whose opening parenthesis has
// already been passed, splitting on the commas that sit at the call's own
// nesting depth so a nested call or object literal is not mistaken for a
// separator.
function argumentAt(
  source: string,
  start: number,
  position: number,
): { readonly argument: string; readonly start: number; readonly end: number } | null {
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
      if (remaining === 0) break;
      remaining -= 1;
      argumentStart = index + 1;
    }
    index += 1;
  }
  if (remaining !== 0) return null;
  return { argument: source.slice(argumentStart, index).trim(), start: argumentStart, end: index };
}

function channelOf(call: ChannelCall): string | null {
  return CHANNEL_REFERENCE.exec(call.argument)?.[1] ?? null;
}

function channelsCalledBy(calls: readonly ChannelCall[], callees: readonly string[]): readonly string[] {
  const channels = new Set<string>();
  for (const call of calls) {
    if (!callees.includes(call.callee)) continue;
    const channel = channelOf(call);
    if (channel !== null) channels.add(channel);
  }
  return [...channels].sort();
}

// Every IPC_CHANNELS reference that does not sit inside a channel argument the
// scan read.
function strayReferences(files: readonly string[], calls: readonly ChannelCall[]): readonly string[] {
  const stray: string[] = [];
  for (const file of files) {
    const source = readSource(file);
    const spans = calls.filter((call) => call.file === file);
    for (const match of source.matchAll(/IPC_CHANNELS\.([A-Za-z0-9_]+)/g)) {
      const read = spans.some((span) => span.start <= match.index && match.index < span.end);
      if (!read) stray.push(`${file}: ${match[0]}`);
    }
  }
  return stray.sort();
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
