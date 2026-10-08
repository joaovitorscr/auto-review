import { describe, expect, it, vi } from "vitest";
import { parseHunks, reviewLines, type ReviewContext } from "./context.js";
import { locatedDiff, scopedDetectorBatches } from "./scoped-batches.js";
import { prepareDetection, review } from "./run.js";

function fixture(before = "const value = 1;\n", after = "const value = 2;\n", patch = "@@ -1 +1 @@\n-const value = 1;\n+const value = 2;\n") {
  const context: ReviewContext = {
    base: "base", head: "head", changes: [{ file: "value.ts", status: "M", patch, hunks: parseHunks(patch), reviewLines: reviewLines(patch, after.split("\n").length - 1) }],
    snippets: [], instructions: [], skipped: [], ignored: [], configErrors: [], omitted: [], diagnostics: [],
  };
  return { context, sources: { before: new Map([["value.ts", before]]), after: new Map([["value.ts", after]]) } };
}

describe("scoped detection", () => {
  it("keeps original coordinates across replacements, hunk gaps and EOF deletions", () => {
    expect(locatedDiff("@@ -2,2 +2,2 @@\n-old\n+new\n same\n@@ -9,2 +9 @@\n last\n-gone\n", 9)).toEqual([
      { kind: "remove", baseLine: 2, anchor: 2, text: "old" },
      { kind: "add", headLine: 2, anchor: 2, text: "new" },
      { kind: "context", baseLine: 3, headLine: 3, anchor: 3, text: "same" },
      { kind: "context", baseLine: 9, headLine: 9, anchor: 9, text: "last" },
      { kind: "remove", baseLine: 10, anchor: 9, text: "gone" },
    ]);
  });

  it("supplies base evidence and preserves it for citation validation", () => {
    const { context, sources } = fixture();
    const plan = prepareDetection(context, sources);
    expect(plan.mode).toBe("scoped");
    expect(plan.context.snippets).toContainEqual(expect.objectContaining({ revision: "base", startLine: 1, endLine: 1, text: "const value = 1;" }));
    const scoped = scopedDetectorBatches(context, sources);
    expect(scoped.batches[0]!.scopes[0]!.diff.map((row) => row.kind)).toEqual(["remove", "add"]);
    expect(plan.context.snippets).toContainEqual(expect.objectContaining({ revision: "head", text: "const value = 2;" }));
    expect(context.snippets).toEqual([]);
    expect(prepareDetection(context).mode).toBe("file");
  });

  it("sends the scoped prompt only when opted in, with a fake provider", async () => {
    const { context, sources } = fixture();
    const complete = vi.fn(async () => ({ output: { findings: [] }, durationMs: 1 }));
    const report = await review(context, { complete }, { scopedSources: sources });
    expect(report.detectionMode).toBe("scoped");
    expect(complete.mock.calls).toHaveLength(1);
    expect(JSON.stringify(complete.mock.calls)).toContain("Scoped mode");
    expect(report.passes).toHaveLength(1);
  });

  it("stops before any provider call when the complete plan exceeds the pass cap", async () => {
    const { context } = fixture();
    const source = `const value = "${"x".repeat(9000)}";\n`;
    const patch = `@@ -0,0 +1 @@\n+${source}`;
    context.changes = Array.from({ length: 5 }, (_, i) => ({ file: `${i}.ts`, status: "A", patch, hunks: parseHunks(patch), reviewLines: [1] }));
    const sources = { before: new Map<string, string>(), after: new Map(context.changes.map((change) => [change.file, source])) };
    const complete = vi.fn(async () => ({ output: { findings: [] }, durationMs: 1 }));
    await expect(review(context, { complete }, { scopedSources: sources, maxParts: 1 })).rejects.toThrow("review passes");
    expect(complete).not.toHaveBeenCalled();
    expect(scopedDetectorBatches(context, sources).batches.every((batch) => JSON.stringify(batch).length <= 80_000)).toBe(true);
  });

  it("refuses an emptied file rather than reporting a complete zero-pass review", () => {
    const { context, sources } = fixture("const value = 1;\n", "", "@@ -1 +0,0 @@\n-const value = 1;\n");
    expect(() => scopedDetectorBatches(context, sources)).toThrow("without surviving head anchors");
  });

  it("rejects unavailable base/head evidence and required payloads that cannot fit", () => {
    const { context, sources } = fixture();
    expect(() => scopedDetectorBatches(context, sources, 10)).toThrow("exceeds");
    expect(() => scopedDetectorBatches(context, { ...sources, before: new Map() })).toThrow("Missing base");
    expect(() => scopedDetectorBatches(context, { ...sources, after: new Map() })).toThrow("unavailable");
  });
});
