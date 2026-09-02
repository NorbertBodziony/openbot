// Appends the domain review fragments whose globs the PR diff touches, so one `codex exec` call
// carries the base instructions plus only the domain knowledge this diff needs.
//
// Fragments are read from the base commit, never from the working tree, for the same reason the
// workflow reads the base prompt that way: a pull request must not be able to rewrite the
// instructions used to review it.
import { execFileSync } from "node:child_process";

const FRAGMENT_DIRECTORY = ".github/review";

export type ReviewFragment = {
  path: string;
  include: string[];
  body: string;
};

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** Parses the `include:` list out of a fragment's front matter and returns the body after it. */
export function parseFragment(path: string, source: string): ReviewFragment {
  const lines = source.split("\n");
  if (lines[0]?.trim() !== "---") throw new Error(`${path}: missing front matter`);

  const closing = lines.indexOf("---", 1);
  if (closing === -1) throw new Error(`${path}: unterminated front matter`);

  const include: string[] = [];
  let inIncludeList = false;
  for (const line of lines.slice(1, closing)) {
    if (line.trim() === "include:") {
      inIncludeList = true;
      continue;
    }
    const item = /^\s*-\s*"?([^"]+)"?\s*$/.exec(line);
    if (inIncludeList && item?.[1]) {
      include.push(item[1]);
      continue;
    }
    if (line.trim() !== "") inIncludeList = false;
  }

  if (include.length === 0) throw new Error(`${path}: front matter has no include globs`);
  return {
    path,
    include,
    body: lines
      .slice(closing + 1)
      .join("\n")
      .trim(),
  };
}

/** Matches the `*` / `**` subset of glob syntax the fragments use. */
export function matchesGlob(glob: string, filePath: string): boolean {
  const pattern = glob
    .split(/(\*\*\/|\*\*|\*)/)
    .map((part) => {
      if (part === "**/") return "(?:.*/)?";
      if (part === "**") return ".*";
      if (part === "*") return "[^/]*";
      return part.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${pattern}$`).test(filePath);
}

export function selectFragments(fragments: ReviewFragment[], changedFiles: string[]): ReviewFragment[] {
  return fragments.filter((fragment) =>
    fragment.include.some((glob) => changedFiles.some((file) => matchesGlob(glob, file))),
  );
}

export function readFragmentsAtCommit(commit: string): ReviewFragment[] {
  let listing: string;
  try {
    listing = git(["ls-tree", "--name-only", commit, `${FRAGMENT_DIRECTORY}/`]);
  } catch {
    return [];
  }

  return listing
    .split("\n")
    .filter((path) => path.endsWith(".md"))
    .sort()
    .map((path) => parseFragment(path, git(["show", `${commit}:${path}`])));
}

export function composeFragments(baseSha: string, changedFiles: string[]): string {
  const selected = selectFragments(readFragmentsAtCommit(baseSha), changedFiles);
  if (selected.length === 0) return "";

  return `\n## Domain review instructions\n\nThese apply to the directories this PR touches. They are instructions, not review material.\n\n${selected
    .map((fragment) => fragment.body)
    .join("\n\n")}\n`;
}

function readChangedFiles(argv: string[], baseSha: string, headSha: string): string[] {
  const override = argv.indexOf("--files-from");
  const source =
    override === -1
      ? git(["diff", "--name-only", `${baseSha}...${headSha}`])
      : execFileSync("cat", [argv[override + 1] ?? ""], { encoding: "utf8" });
  return source.split("\n").filter((line) => line.trim() !== "");
}

if (import.meta.main) {
  const [baseSha, headSha] = process.argv.slice(2);
  if (!baseSha || !headSha) {
    console.error("usage: bun scripts/compose-review-prompt.ts <base-sha> <head-sha> [--files-from <file>]");
    process.exit(2);
  }
  process.stdout.write(composeFragments(baseSha, readChangedFiles(process.argv, baseSha, headSha)));
}
