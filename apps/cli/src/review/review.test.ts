import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArguments } from "../input.js";
import { batchContext, packContext, parseHunks, reviewLines } from "./context.js";
import type { ReviewContext } from "./context.js";
import { withReviewContext } from "./git.js";
import { review, renderReview, validationContext } from "./run.js";
import type { ModelProvider } from "./agent.js";

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
  ignored: [],
  configErrors: [],
  omitted: [],
  diagnostics: [],
};
const audit = {
  observations: [{ claim: "The conversion changed.", evidenceIndices: [1] }],
  conclusion: "The caller receives cents where it expects dollars.",
  counterChecks: [
    {
      check: "Does the caller convert units?",
      result: "supports_finding",
      summary: "The supplied caller forwards the value.",
    },
  ],
  uncertainties: ["Only supplied context was inspected."],
};
const finding = {
  audit,
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
      agent: "codex",
      dryRun: true,
    });
    expect(parseArguments(["review", "--base", "main", "--agent", "claude"])).toMatchObject({
      agent: "claude",
    });
    expect(() => parseArguments(["review", "--base", "main", "--agent", "gpt"])).toThrow(
      "--agent must be codex or claude",
    );
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
  it("supplies uncited cross-file counterevidence and makes budget omissions explicit", async () => {
    const independent = { file: "probe.ts", revision: "head" as const, startLine: 1, endLine: 1,
      text: "export const probe = () => readUsage(process.env);", reason: "caller" };
    const input = { ...context, snippets: [...context.snippets, independent] };
    const { model, prompts } = provider([
      { findings: [finding] },
      { decisions: [{ candidateId: 1, verdict: "needs_more_context", reason: "Identity unresolved", audit }] },
    ]);
    await review(input, model);
    expect(prompts[1]).toContain(independent.text);
    expect(prompts[1]).toContain("judge the action against that selection");
    const budget = JSON.stringify(independent).length + 1;
    expect(validationContext(input, budget, ["probe.ts"]).snippets).toEqual([independent]);
    expect(validationContext(input, 1)).toEqual({ snippets: [], omitted: [
      "validator:head:amount.ts:1-3", "validator:head:probe.ts:1-1",
    ] });
  });

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
            audit,
            reason: "The changed conversion reaches the dollar API.",
          },
          { candidateId: 2, verdict: "reject", audit, reason: "The caller guards it." },
          {
            candidateId: 3,
            verdict: "needs_more_context",
            audit,
            reason: "The API contract is missing.",
          },
        ],
      },
    ]);
    const report = await review(context, model);
    expect(report.findings).toEqual([finding]);
    expect(report.records[0]?.validatorAudit).toEqual(audit);
    expect(report.records[1]?.validatorAudit).toEqual(audit);
    expect(report.policyVersion).toBe(2);
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
          { ...finding, title: "Low confidence", confidence: 0.4 },
          {
            ...finding,
            title: "Invented evidence",
            evidence: [{ file: "elsewhere.ts", revision: "head", startLine: 1, endLine: 1 }],
          },
        ],
      },
      {
        decisions: [
          { candidateId: 1, verdict: "accept", audit, reason: "Evidence supports the regression." },
        ],
      },
    ]);
    const report = await review(context, model);
    expect(report.findings).toHaveLength(1);
    expect(report.records.filter((record) => record.verdict === "reject")).toHaveLength(4);
    expect(prompts).toHaveLength(2);
  });
  it("runs the counter-review with a separate validator provider when given one", async () => {
    const detector = provider([{ findings: [finding] }]);
    const validator = provider([
      { decisions: [{ candidateId: 1, verdict: "accept", audit, reason: "Evidence supports the regression." }] },
    ]);
    const report = await review(context, detector.model, { validator: validator.model });
    expect(report.findings).toHaveLength(1);
    expect(detector.prompts).toHaveLength(1);
    expect(validator.prompts[0]).toContain("Try to disprove");
  });
  it("keeps the detector's survey on its pass and tolerates its absence", async () => {
    const survey = [{ file: "src/a.ts", line: 3, behaviour: "Parses the amount", risk: "none" }];
    const { model } = provider([{ survey, findings: [] }]);
    const report = await review(context, model);
    expect(report.passes[0]?.survey).toEqual(survey);
    const bare = provider([{ findings: [] }]);
    expect((await review(context, bare.model)).passes[0]?.survey).toEqual([]);
  });
  it("records eligible candidates as unjudged when the counter-review is skipped", async () => {
    const { model, prompts } = provider([{ findings: [finding, { ...finding, line: 1 }] }]);
    const report = await review(context, model, { judge: false });
    expect(prompts).toHaveLength(1);
    expect(report.findings).toEqual([]);
    expect(report.records.map(({ verdict, reason }) => [verdict, reason])).toEqual([
      ["needs_more_context", "Counter-review skipped."],
      ["reject", expect.any(String)],
    ]);
  });
  it("runs every detector on each batch and judges their candidates together", async () => {
    const first = provider([{ findings: [finding] }]);
    const second = provider([{ findings: [{ ...finding, title: "A second concern" }] }]);
    const judge = provider([
      { decisions: [1, 2].map((candidateId) => ({ candidateId, verdict: "reject", audit, reason: "Guarded." })) },
    ]);
    const report = await review(context, [{ ...first.model, name: "codex" }, { ...second.model, name: "claude" }], {
      validator: { ...judge.model, name: "claude" },
    });
    expect([first.prompts.length, second.prompts.length]).toEqual([1, 1]);
    expect(judge.prompts[0]).toContain("A second concern");
    expect(report.records).toHaveLength(2);
    expect(report.passes.map(({ phase, agent }) => [phase, agent])).toEqual([
      ["detector", "codex"],
      ["detector", "claude"],
      ["validator", "claude"],
    ]);
  });
  it("collapses accepted findings within three lines of each other into the strongest one", async () => {
    const twoLines = { ...context, changes: [{ ...context.changes[0]!, reviewLines: [2, 3] }] };
    const weaker = { ...finding, title: "Same bug, other line", line: 3, severity: "medium" };
    const { model } = provider([
      { findings: [weaker, finding] },
      { decisions: [1, 2].map((candidateId) => ({ candidateId, verdict: "accept", audit, reason: "Reachable." })) },
    ]);
    const report = await review(twoLines, model);
    expect(report.findings).toEqual([finding]);
    expect(report.records[0]).toMatchObject({ verdict: "reject", reason: "Duplicate of an accepted finding." });
  });
  it("accepts head evidence the agent read from the checkout and rejects ranges that do not exist", async () => {
    const checkout = await mkdtemp(join(tmpdir(), "auto-review-retrieved-"));
    try {
      await writeFile(join(checkout, "schema.ts"), "export const unit = 'dollars';\n");
      const cite = (file: string, endLine: number) => ({
        ...finding,
        title: `Cites ${file}:${endLine}`,
        evidence: [...finding.evidence, { file, revision: "head" as const, startLine: 1, endLine }],
      });
      const { model, prompts } = provider([
        { findings: [cite("schema.ts", 1), cite("schema.ts", 9), cite("../outside.ts", 1)] },
        {
          decisions: [
            { candidateId: 1, verdict: "accept", audit, reason: "The schema stores dollars." },
          ],
        },
      ]);
      const report = await review(context, model, { checkout });
      expect(report.findings.map((entry) => entry.title)).toEqual(["Cites schema.ts:1"]);
      expect(report.retrieved).toEqual([
        { file: "schema.ts", startLine: 1, endLine: 1, text: "export const unit = 'dollars';" },
      ]);
      expect(prompts[1]).toContain("export const unit = 'dollars';");
    } finally {
      await rm(checkout, { recursive: true, force: true });
    }
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
          { decisions: [{ candidateId: 2, verdict: "accept", audit, reason: "Wrong ID" }] },
        ]).model,
      ),
    ).rejects.toThrow("exactly one");
  });
  it("skips validation with no findings, and skips the agent entirely with no supported changes", async () => {
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
      ignored: [],
      configErrors: [],
    };
    expect(packContext(input, 1000).omitted).not.toHaveLength(0);
    expect(() => packContext(input, 10)).toThrow("context budget");
  });

  it("packs string tables after code and flags big rewrites with little context", () => {
    const table = Array.from({ length: 30 }, (_, line) => `  key${line}: "text ${line}",`).join("\n");
    const code = { ...context.snippets[0], file: "b.ts" };
    const data = { ...context.snippets[0], file: "strings.ts", text: table };
    const rewrite = { ...context.changes[0], patch: "+x\n".repeat(8000) };
    const [batch] = batchContext({ ...context, changes: [rewrite], snippets: [data, code] }, 100_000);
    expect(batch.snippets.findIndex((snippet) => snippet.file === "strings.ts")).toBeGreaterThan(batch.snippets.findIndex((snippet) => snippet.file === "b.ts"));
    expect(batch.readFirst).toEqual(["amount.ts"]);
  });

  it("splits large contexts so each detector pass keeps its own changed files", () => {
    const changes = ["a.ts", "b.ts", "c.ts"].map((file) => ({ ...context.changes[0], file }));
    const snippets = changes.map((change) => ({ ...context.snippets[0], file: change.file }));
    const batches = batchContext({ ...context, changes, snippets }, 1200);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flatMap((batch) => batch.changes.map((change) => change.file))).toEqual(["a.ts", "b.ts", "c.ts"]);
    for (const batch of batches) {
      expect(JSON.stringify(batch).length).toBeLessThanOrEqual(1200);
      for (const change of batch.changes)
        expect(batch.snippets.some((snippet) => snippet.file === change.file)).toBe(true);
    }
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
      await writeFile(join(root, "NOTES.md"), "Changed docs.\n");
      await writeFile(join(root, "styles.css"), "body { color: red; }\n");
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
      expect(packed.ignored).toEqual(["NOTES.md"]);
      expect(packed.skipped).toEqual(["styles.css"]);
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

it("fails rather than inventing missing audits or accepting nonexistent audit evidence", async () => {
  await expect(
    review(context, provider([{ findings: [{ ...finding, audit: undefined }] }]).model),
  ).rejects.toThrow();
  const invalidAudit = { ...audit, observations: [{ claim: "Unsupported", evidenceIndices: [2] }] };
  await expect(
    review(context, provider([{ findings: [{ ...finding, audit: invalidAudit }] }]).model),
  ).rejects.toThrow("nonexistent evidence");
  await expect(
    review(
      context,
      provider([
        { findings: [finding] },
        {
          decisions: [
            { candidateId: 1, verdict: "accept", reason: "Accepted", audit: invalidAudit },
          ],
        },
      ]).model,
    ),
  ).rejects.toThrow("nonexistent evidence");
});
