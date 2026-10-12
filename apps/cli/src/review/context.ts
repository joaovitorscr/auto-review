import type { indexProgram } from "../ast.js";

export function parseHunks(patch: string) {
  return [...patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map((match) => ({
    oldStart: Number(match[1]),
    oldLines: Number(match[2] ?? 1),
    newStart: Number(match[3]),
    newLines: Number(match[4] ?? 1),
  }));
}

/** The patch lines within `margin` head lines of one of `lines`, each run under a head-position header. */
export function hunksNear(patch: string, lines: number[], margin = 40) {
  const kept: string[] = [];
  let position = 0;
  let inHunk = false;
  let open = false;
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      position = Number(hunk[1]);
      inHunk = true;
      open = false;
      continue;
    }
    if (!inHunk || !line) continue;
    if (lines.some((target) => Math.abs(target - position) <= margin)) {
      if (!open) kept.push(`@@ head line ${position} @@`);
      open = true;
      kept.push(line);
    } else open = false;
    if (!line.startsWith("-")) position += 1;
  }
  return kept.join("\n");
}

/** Lines added on the head side, or the nearest surviving line for a deletion. */
export function reviewLines(patch: string, lineCount: number) {
  const lines = new Set<number>();
  let position = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      position = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) {
      lines.add(position);
      position += 1;
    } else if (line.startsWith("-")) lines.add(Math.max(1, Math.min(position, lineCount)));
    else if (line.startsWith(" ")) position += 1;
  }
  return [...lines].filter((line) => line >= 1 && line <= lineCount).sort((a, b) => a - b);
}

export type Change = {
  file: string;
  status: string;
  patch: string;
  hunks: ReturnType<typeof parseHunks>;
  reviewLines: number[];
};

type Snippet = {
  file: string;
  revision: "base" | "head";
  startLine: number;
  endLine: number;
  reason: string;
  text: string;
};

/** Packs changed code first, then one-hop callers, callees, imports and importing tests. */
export function packContext(
  input: {
    base: string;
    head: string;
    changes: Change[];
    index: ReturnType<typeof indexProgram>;
    before: ReadonlyMap<string, string>;
    after: ReadonlyMap<string, string>;
    instructions: Array<{ file: string; text: string }>;
    skipped: string[];
    ignored: string[];
    configErrors: Array<{ config: string; message: string }>;
  },
  maxCharacters = 800_000,
) {
  const { index, before, after, ...metadata } = input;
  const snippets: Snippet[] = [];
  const omitted = new Set<string>();
  if (JSON.stringify(metadata).length > maxCharacters)
    throw new Error(
      `The diff and instructions exceed the ${maxCharacters.toLocaleString("en-US")}-character context budget. Review a smaller commit range.`,
    );
  // The budget is for retrieved code only. Charging the diff against it left large PRs with
  // almost no context (othos-36: 377k of diff, 11 snippets kept, 3,832 dropped) while the
  // per-pass batches, which enforce their own limit, sat a third empty.
  let remaining = maxCharacters;
  const add = (
    file: string,
    revision: "base" | "head",
    start: number,
    end: number,
    reason: string,
  ) => {
    const source = (revision === "base" ? before : after).get(file);
    if (source === undefined) return;
    const lines = source.split("\n");
    const startLine = Math.max(1, start);
    const endLine = Math.min(lines.length, end);
    if (
      endLine < startLine ||
      snippets.some(
        (snippet) =>
          snippet.file === file &&
          snippet.revision === revision &&
          snippet.startLine <= startLine &&
          snippet.endLine >= endLine,
      )
    )
      return;
    const snippet = {
      file,
      revision,
      startLine,
      endLine,
      reason,
      text: lines.slice(startLine - 1, endLine).join("\n"),
    };
    const cost = JSON.stringify(snippet).length;
    if (cost > remaining) {
      omitted.add(`${revision}:${file}:${startLine}-${endLine}`);
      return;
    }
    remaining -= cost;
    snippets.push(snippet);
  };
  const changedSymbols = index.symbols.filter((symbol) =>
    input.changes.some(
      (change) =>
        change.file === symbol.file &&
        change.reviewLines.some((line) => line >= symbol.startLine && line <= symbol.endLine),
    ),
  );
  for (const change of input.changes)
    for (const hunk of change.hunks)
      add(change.file, "head", hunk.newStart - 15, hunk.newStart + hunk.newLines + 15, "after change");
  // A changed symbol is usually a function; a 2,000-line route registrar or page component is
  // one symbol too, and as a single snippet it never fits a batch. Long symbols contribute
  // windows around their changed lines instead.
  const longSymbol = 200;
  for (const symbol of changedSymbols) {
    if (symbol.endLine - symbol.startLine < longSymbol) {
      add(symbol.file, "head", symbol.startLine, symbol.endLine, `changed ${symbol.name}`);
      continue;
    }
    const lines = input.changes.find((change) => change.file === symbol.file)!.reviewLines.filter((line) => line >= symbol.startLine && line <= symbol.endLine);
    for (const line of lines) add(symbol.file, "head", line - 40, line + 40, `changed ${symbol.name} (window)`);
  }
  const ids = new Set(changedSymbols.map((symbol) => symbol.id));
  const byId = new Map(index.symbols.map((symbol) => [symbol.id, symbol]));
  for (const call of index.calls) {
    if (!((call.target && ids.has(call.target)) || (call.caller && ids.has(call.caller)))) continue;
    for (const [id, reason] of [
      [call.caller, "caller"],
      [call.target, "callee"],
    ] as const) {
      const symbol = id ? byId.get(id) : undefined;
      if (symbol)
        add(symbol.file, "head", symbol.startLine, symbol.endLine, `${reason} ${symbol.name}`);
    }
    add(call.file, "head", call.startLine - 8, call.endLine + 8, "call site");
  }
  // The base version matters less than what the head code calls, so it comes after the one-hop context.
  for (const change of input.changes)
    for (const hunk of change.hunks)
      add(change.file, "base", hunk.oldStart - 15, hunk.oldStart + hunk.oldLines + 15, "before change");
  const changedFiles = new Set(input.changes.map((change) => change.file));
  for (const entry of index.imports) {
    if (entry.target && changedFiles.has(entry.target))
      add(entry.file, "head", 1, 200, "imports changed file");
    if (entry.target && changedFiles.has(entry.file))
      add(entry.target, "head", 1, 200, "dependency of changed file");
  }
  const reviewed = new Set(snippets.map((snippet) => snippet.file));
  return {
    ...metadata,
    snippets,
    omitted: [...omitted],
    diagnostics: index.diagnostics.filter((diagnostic) => reviewed.has(diagnostic.file)),
  };
}

export type ReviewContext = ReturnType<typeof packContext>;

/** True when most lines are literal entries such as `key: "text",`. */
function isData(text: string) {
  const lines = text.split("\n").filter((line) => line.trim());
  const entries = lines.filter((line) => /^\s*["'\w$-]+\s*:\s*(["'`]|\d|true|false|null)/.test(line));
  return lines.length >= 20 && entries.length / lines.length > 0.6;
}

/**
 * Splits a context into detector-sized pieces: changed files are grouped greedily, each group
 * gets its own hunk snippets first, then the remaining snippets in packing order until full.
 */
export function batchContext(context: ReviewContext, maxCharacters = 240_000) {
  const size = (value: unknown) => JSON.stringify(value).length;
  // Coverage lists stay in the report; the detector only needs code and instructions.
  const shared = { base: context.base, head: context.head, instructions: context.instructions, skipped: context.skipped };
  const fixed = size({ ...shared, changes: [], snippets: [] });
  // Half of what is left after shared metadata goes to diffs, the rest to snippets.
  const diffBudget = (maxCharacters - fixed) / 2;
  if (diffBudget <= 0)
    throw new Error("Instructions and file lists alone exceed the detector context budget.");
  const groups: Array<typeof context.changes> = [];
  let used = Infinity;
  for (const change of context.changes) {
    const cost = size(change);
    if (used + cost > diffBudget) {
      groups.push([]);
      used = 0;
    }
    groups.at(-1)!.push(change);
    used += cost;
  }
  return groups.map((changes) => {
    const files = new Set(changes.map((change) => change.file));
    const own = context.snippets.filter((snippet) => files.has(snippet.file));
    const rest = context.snippets.filter((snippet) => !files.has(snippet.file));
    let remaining = maxCharacters - fixed - size(changes);
    const snippets: typeof context.snippets = [];
    // Most useful first: head code of the changed files, then what the change calls and who calls
    // it, then the base version, then whole-file import chunks. Data tables fill leftover space.
    const priority = (snippet: Snippet) =>
      snippet.reason.startsWith("after") || snippet.reason.startsWith("changed") ? 0
      : snippet.reason.startsWith("callee") || snippet.reason.startsWith("caller") ? 1
      : snippet.reason.startsWith("call site") ? 2
      : snippet.reason.startsWith("before") ? 3
      : 4;
    const ordered = [...own, ...rest].sort((a, b) => Number(isData(a.text)) - Number(isData(b.text)) || Number(files.has(b.file)) - Number(files.has(a.file)) || priority(a) - priority(b) || a.text.length - b.text.length);
    for (const snippet of ordered) {
      const cost = size(snippet);
      if (cost > remaining) continue;
      remaining -= cost;
      snippets.push(snippet);
    }
    // Big rewrites arrive as a long patch with little surrounding code; the detector reads those itself.
    const readFirst = changes
      .filter((change) => {
        const covered = snippets
          .filter((snippet) => snippet.file === change.file && snippet.revision === "head")
          .reduce((sum, snippet) => sum + snippet.text.length, 0);
        return change.patch.length > 20_000 && covered < change.patch.length / 4;
      })
      .map((change) => change.file);
    return { ...shared, changes, snippets, readFirst };
  });
}
