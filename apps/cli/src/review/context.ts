import type { indexProgram } from "../ast.js";

export function parseHunks(patch: string) {
  return [...patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map((match) => ({
    oldStart: Number(match[1]),
    oldLines: Number(match[2] ?? 1),
    newStart: Number(match[3]),
    newLines: Number(match[4] ?? 1),
  }));
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
  maxCharacters = 400_000,
) {
  const { index, before, after, ...metadata } = input;
  const snippets: Snippet[] = [];
  const omitted = new Set<string>();
  let remaining = maxCharacters - JSON.stringify(metadata).length;
  if (remaining < 0)
    throw new Error(
      `The diff and instructions exceed the ${maxCharacters.toLocaleString("en-US")}-character context budget. Review a smaller commit range.`,
    );
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
  for (const change of input.changes) {
    for (const hunk of change.hunks) {
      add(
        change.file,
        "base",
        hunk.oldStart - 15,
        hunk.oldStart + hunk.oldLines + 15,
        "before change",
      );
      add(
        change.file,
        "head",
        hunk.newStart - 15,
        hunk.newStart + hunk.newLines + 15,
        "after change",
      );
    }
  }
  for (const symbol of changedSymbols)
    add(symbol.file, "head", symbol.startLine, symbol.endLine, `changed ${symbol.name}`);
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

/**
 * Splits a context into detector-sized pieces: changed files are grouped greedily, each group
 * gets its own hunk snippets first, then the remaining snippets in packing order until full.
 */
export function batchContext(context: ReviewContext, maxCharacters = 80_000) {
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
    const snippets = [];
    for (const snippet of [...own, ...rest]) {
      const cost = size(snippet);
      if (cost > remaining) continue;
      remaining -= cost;
      snippets.push(snippet);
    }
    return { ...shared, changes, snippets };
  });
}
