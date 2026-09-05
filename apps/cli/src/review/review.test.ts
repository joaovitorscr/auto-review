import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArguments } from "../input.js";
import { packContext, parseHunks, reviewLines } from "./context.js";
import type { ReviewContext } from "./context.js";
import { withReviewContext } from "./git.js";
import { review, renderReview } from "./run.js";
import type { ModelProvider } from "./codex.js";

const patch =
  "@@ -1,3 +1,3 @@\n export function amount(cents: number) {\n-  return cents / 100;\n+  return cents;\n }\n";
const context: ReviewContext = {
  base: "a".repeat(40),
  head: "b".repeat(40),
  changes: [{ file: "amount.ts", status: "M", patch, hunks: parseHunks(patch), reviewLines: [2] }],
  snippets: [
    {
      file: "amount.ts",
      revision: "head",
      startLine: 1,
      endLine: 3,
      text: "export function amount(cents: number) {\n  return cents;\n}",
      reason: "changed",
    },
  ],
  instructions: [],
  skipped: [],
  omitted: [],
  diagnostics: [],
};
const finding = {
  title: "Convert cents before sending the amount",
  severity: "high",
  confidence: 0.95,
  file: "amount.ts",
  line: 2,
  explanation: "The caller expects dollars and now receives cents.",
  scenario: "A 100-cent payment is charged as 100 dollars.",
  suggestedFix: "Divide cents by 100.",
  evidence: [{ file: "amount.ts", revision: "head", startLine: 1, endLine: 3 }],
};
function provider(outputs: unknown[]) {
  const prompts: string[] = [];
  const model: ModelProvider = {
    async complete(request) {
      prompts.push(request.prompt);
      return { output: outputs.shift(), durationMs: 1 };
    },
  };
  return { model, prompts };
}

describe("review inputs and diff ranges", () => {
  it("requires a base and accepts a dry run without a model", () => {
    expect(() => parseArguments(["review"])).toThrow("--base");
    expect(parseArguments(["review", "--base", "main", "--dry-run"])).toMatchObject({
      command: "review",
      base: "main",
      head: "HEAD",
      dryRun: true,
    });
    expect(() => parseArguments(["review", "--base", "--head"])).toThrow("needs a value");
    expect(() => parseArguments(["review", "--base", "main", "--bogus"])).toThrow(
      "Unknown review option",
    );
  });
  it("finds actual changed lines instead of unchanged hunk context", () => {
    expect(reviewLines(patch, 3)).toEqual([2]);
    expect(parseHunks("@@ -0,0 +1 @@\n+x")).toEqual([
      { oldStart: 0, oldLines: 0, newStart: 1, newLines: 1 },
    ]);
    expect(reviewLines("@@ -1,2 +1 @@\n x\n-y", 1)).toEqual([1]);
    expect(reviewLines("@@ -1 +0,0 @@\n-x", 0)).toEqual([]);
  });
});

describe("counter-review", () => {
  it("publishes accepted candidates and keeps rejected and uncertain decisions", async () => {
    const { model, prompts } = provider([
      {
        findings: [
          finding,
          { ...finding, title: "A second concern" },
          { ...finding, title: "An uncertain concern" },
        ],
      },
      {
        decisions: [
          {
            candidateId: 1,
            verdict: "accept",
            reason: "The changed conversion reaches the dollar API.",
          },
          { candidateId: 2, verdict: "reject", reason: "The caller guards it." },
          { candidateId: 3, verdict: "needs_more_context", reason: "The API contract is missing." },
        ],
      },
    ]);
    const report = await review(context, model);
    expect(report.findings).toEqual([finding]);
    expect(report.records.map((record) => record.verdict)).toEqual([
      "accept",
      "reject",
      "needs_more_context",
    ]);
    expect(prompts[1]).toContain("Try to disprove");
    expect(report.contextHash).toMatch(/^[a-f0-9]{64}$/);
    expect(renderReview(report)).toContain("amount.ts:2");
  });
  it("rejects invented citations, unchanged anchors, duplicates and low confidence before validation", async () => {
    const { model, prompts } = provider([
      {
        findings: [
          finding,
          finding,
          { ...finding, line: 1 },
          { ...finding, title: "Low confidence", confidence: 0.7 },
          {
            ...finding,
            title: "Invented evidence",
            evidence: [{ file: "elsewhere.ts", revision: "head", startLine: 1, endLine: 1 }],
          },
        ],
      },
      {
        decisions: [
          { candidateId: 1, verdict: "accept", reason: "Evidence supports the regression." },
        ],
      },
    ]);
    const report = await review(context, model);
    expect(report.findings).toHaveLength(1);
    expect(report.records.filter((record) => record.verdict === "reject")).toHaveLength(4);
    expect(prompts).toHaveLength(2);
  });
  it("fails on malformed model output or incomplete validation rather than reporting a clean review", async () => {
    await expect(
      review(context, provider([{ findings: [{ ...finding, confidence: "high" }] }]).model),
    ).rejects.toThrow("confidence");
    await expect(
      review(context, provider([{ findings: [finding] }, { decisions: [] }]).model),
    ).rejects.toThrow("exactly one");
    await expect(
      review(
        context,
        provider([
          { findings: [finding] },
          { decisions: [{ candidateId: 2, verdict: "accept", reason: "Wrong ID" }] },
        ]).model,
      ),
    ).rejects.toThrow("exactly one");
  });
  it("skips validation with no findings, and skips Codex entirely with no supported changes", async () => {
    const negative = provider([{ findings: [] }]);
    expect((await review(context, negative.model)).findings).toEqual([]);
    expect(negative.prompts).toHaveLength(1);
    const empty = provider([]);
    expect(renderReview(await review({ ...context, changes: [] }, empty.model))).toContain(
      "No supported",
    );
    expect(empty.prompts).toHaveLength(0);
  });
});

describe("context budget", () => {
  it("reports omitted source ranges and refuses to silently truncate the diff", () => {
    const input = {
      base: context.base,
      head: context.head,
      changes: context.changes,
      index: { files: ["amount.ts"], symbols: [], imports: [], calls: [], diagnostics: [] },
      before: new Map<string, string>(),
      after: new Map([["amount.ts", "x".repeat(2000)]]),
      instructions: [],
      skipped: [],
    };
    expect(packContext(input, 1000).omitted).not.toHaveLength(0);
    expect(() => packContext(input, 10)).toThrow("context budget");
  });
});

describe("Git and AST context", () => {
  it("uses the merge base and immutable head, includes unchanged callers, and cleans up on failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "auto-review-fixture-"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
    try {
      git("init", "--quiet");
      git("config", "commit.gpgsign", "false");
      git("config", "user.name", "Fixture");
      git("config", "user.email", "fixture@example.test");
      await writeFile(
        join(root, "amount.ts"),
        "export function amount(cents: number) {\n  return cents / 100;\n}\n",
      );
      await writeFile(
        join(root, "caller.ts"),
        'import { amount } from "./amount";\nexport function charge() { return { dollars: amount(100) }; }\n',
      );
      await writeFile(join(root, "AGENTS.md"), "Amounts sent to the API are in dollars.\n");
      git("add", ".");
      git("-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "base");
      const base = git("rev-parse", "HEAD");
      await writeFile(join(root, "amount.ts"), context.snippets[0]!.text + "\n");
      git("add", ".");
      git("-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "regression");
      const head = git("rev-parse", "HEAD");
      git("checkout", "--quiet", "-b", "advanced-base", base);
      await writeFile(join(root, "unrelated.ts"), "export const unrelated = true;\n");
      git("add", ".");
      git("-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "unrelated base work");
      await writeFile(join(root, "amount.ts"), "local dirty work\n");
      const beforeWorktrees = git("worktree", "list", "--porcelain");
      const packed = await withReviewContext(
        { repository: root, base: "advanced-base", head },
        async (result) => result,
      );
      expect(packed.base).toBe(base);
      expect(packed.head).toBe(head);
      expect(packed.changes.map((change) => change.file)).toEqual(["amount.ts"]);
      expect(packed.snippets).toContainEqual(
        expect.objectContaining({ file: "caller.ts", reason: "caller charge" }),
      );
      expect(packed.snippets).toContainEqual(
        expect.objectContaining({
          file: "amount.ts",
          revision: "base",
          text: expect.stringContaining("cents / 100"),
        }),
      );
      expect(packed.instructions[0]?.text).toContain("dollars");
      expect(JSON.stringify(packed)).not.toContain("local dirty work");
      await expect(
        withReviewContext({ repository: root, base, head }, async () => {
          throw new Error("provider failed");
        }),
      ).rejects.toThrow("provider failed");
      expect(git("worktree", "list", "--porcelain")).toBe(beforeWorktrees);
      expect(await readFile(join(root, "amount.ts"), "utf8")).toBe("local dirty work\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
