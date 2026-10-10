import { baseComparisons } from "./base-comparisons.js";
import type { ReviewContext } from "./context.js";
import { planDetectorScopes } from "./scopes.js";

/** Diff rows keep original coordinates; a gap between rows is omitted code, never adjacency. */
export function locatedDiff(patch: string, headLines: number) {
  const rows: Array<{ kind: "context" | "add" | "remove"; baseLine?: number; headLine?: number; anchor: number; text: string }> = [];
  let base = 0;
  let head = 0;
  let active = false;
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      base = Number(hunk[1]); head = Number(hunk[2]); active = true;
      continue;
    }
    if (!active) continue;
    const anchor = Math.max(1, Math.min(head, headLines));
    if (line.startsWith("+")) rows.push({ kind: "add", headLine: head++, anchor, text: line.slice(1) });
    else if (line.startsWith("-")) rows.push({ kind: "remove", baseLine: base++, anchor, text: line.slice(1) });
    else if (line.startsWith(" ")) rows.push({ kind: "context", baseLine: base++, headLine: head++, anchor, text: line.slice(1) });
  }
  return rows;
}

/** Opt-in scoped payloads. Throws on incomplete primary coverage or a payload that cannot fit. */
export function scopedDetectorBatches(
  context: ReviewContext,
  sources: { before: ReadonlyMap<string, string>; after: ReadonlyMap<string, string> },
  maxCharacters = 80_000,
) {
  const unanchored = context.changes.filter((change) => change.patch && !change.reviewLines.length);
  if (unanchored.length) throw new Error(`Scoped detection cannot cover changes without surviving head anchors: ${unanchored.map((change) => change.file).join(", ")}`);
  const inventory = planDetectorScopes(context.changes, sources.after);
  if (!inventory.boundedHeadCoverage)
    throw new Error(`Scoped detection has unavailable, unowned, malformed or oversized primary code: ${inventory.files.filter((file) => file.unavailable || file.unowned.length || file.diagnostics.length || file.scopes.some((scope) => scope.oversized)).map((file) => file.file).join(", ")}`);
  const baseEvidence: ReviewContext["snippets"] = [];
  const headEvidence: ReviewContext["snippets"] = [];
  const omitted: string[] = [];
  const shared = { base: context.base, head: context.head, instructions: context.instructions, skipped: context.skipped };
  const scopes = inventory.files.flatMap((file) => {
    const change = context.changes.find((entry) => entry.file === file.file)!;
    if (change.status !== "A" && !sources.before.has(file.file))
      throw new Error(`Missing base source for scoped detection: ${file.file}`);
    const headSource = sources.after.get(file.file)!;
    const headLines = headSource ? headSource.split("\n").length - Number(headSource.endsWith("\n")) : 0;
    const rows = locatedDiff(change.patch, headLines);
    const before = sources.before.get(file.file)?.split("\n") ?? [];
    const selected = new Set<(typeof rows)[number]>();
    const planned = file.scopes.map((scope) => {
      const diff = rows.filter((row) => scope.payload.primary.some((entry) => row.anchor >= entry.startLine && row.anchor <= entry.endLine));
      for (const row of diff) selected.add(row);
      const lines = [...new Set(diff.flatMap((row) => row.baseLine === undefined ? [] : [row.baseLine]))].sort((a, b) => a - b);
      const ranges: Array<{ start: number; end: number }> = [];
      for (const line of lines) {
        const last = ranges.at(-1);
        if (last && line === last.end + 1) last.end = line;
        else ranges.push({ start: line, end: line });
      }
      const base = ranges.map(({ start, end }) => {
        if (start < 1 || end > before.length) throw new Error(`Invalid base coordinates for ${file.file}:${start}-${end}`);
        return { file: file.file, revision: "base" as const, startLine: start, endLine: end, reason: "scoped diff evidence", text: before.slice(start - 1, end).join("\n") };
      });
      const comparisonOmissions: string[] = [];
      let comparisonCharacters = 0;
      for (const entry of baseComparisons(file.file, sources.before.get(file.file) ?? "", scope.payload.primary.map((part) => part.text))) {
        if (base.some((covered) => covered.startLine <= entry.startLine && covered.endLine >= entry.endLine)) continue;
        if (comparisonCharacters + JSON.stringify(entry).length > 12_000) {
          comparisonOmissions.push(`${scope.id}:base:${file.file}:${entry.startLine}-${entry.endLine}`);
          continue;
        }
        comparisonCharacters += JSON.stringify(entry).length;
        base.push(entry);
      }
      const payload = { id: scope.id, ...scope.payload, diff, base, comparisonOmissions, omitted: [...scope.omitted], unresolved: scope.unresolved };
      // Reserve room for immutable diff/base evidence before spending space on optional support.
      while (JSON.stringify({ ...shared, scopes: [payload] }).length > maxCharacters && payload.supporting.length) {
        const entry = payload.supporting.pop()!;
        payload.omitted.push({ start: entry.start, end: entry.end, startLine: entry.startLine, endLine: entry.endLine, reason: "support excluded to fit diff/base evidence" });
      }
      // Comparison leads are optional; the original diff evidence is mandatory.
      while (JSON.stringify({ ...shared, scopes: [payload] }).length > maxCharacters && base.some((entry) => entry.reason.startsWith("Comparison lead"))) {
        const index = base.findLastIndex((entry) => entry.reason.startsWith("Comparison lead"));
        const [entry] = base.splice(index, 1);
        comparisonOmissions.push(`${scope.id}:base:${file.file}:${entry!.startLine}-${entry!.endLine}`);
      }
      baseEvidence.push(...base);
      omitted.push(...comparisonOmissions);
      headEvidence.push(...[...payload.primary, ...payload.supporting].map((entry) => ({ file: file.file, revision: "head" as const, startLine: entry.startLine, endLine: entry.endLine, text: headSource.split("\n").slice(entry.startLine - 1, entry.endLine).join("\n"), reason: "scoped head evidence" })));
      omitted.push(...payload.omitted.map((entry) => `${scope.id}:head:${file.file}:${entry.startLine}-${entry.endLine}`));
      omitted.push(...scope.unresolved.map((name) => `${scope.id}:unresolved:${name}`));
      return payload;
    });
    if (rows.some((row) => row.kind !== "context" && !selected.has(row)))
      throw new Error(`Scoped detection lost changed diff rows for ${file.file}`);
    return planned;
  });
  const batches: Array<typeof shared & { scopes: typeof scopes }> = [];
  for (const scope of scopes) {
    const previous = batches.at(-1);
    if (previous && JSON.stringify({ ...previous, scopes: [...previous.scopes, scope] }).length <= maxCharacters)
      previous.scopes.push(scope);
    else {
      const next = { ...shared, scopes: [scope] };
      if (JSON.stringify(next).length > maxCharacters)
        throw new Error(`Scoped payload ${scope.id} exceeds ${maxCharacters} characters including diff evidence.`);
      batches.push(next);
    }
  }
  return { batches, baseEvidence, headEvidence, omitted, scopeCount: scopes.length };
}
