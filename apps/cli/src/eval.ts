#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeProvider } from "./review/claude.js";
import { codexProvider } from "./review/codex.js";
import { withReviewContext } from "./review/git.js";
import { prepareDetection, review } from "./review/run.js";

const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
// evals/ cases are committed and inline; corpus/cases/ point at local clones and stay git-ignored.
const CASE_ROOTS = [join(WORKSPACE_ROOT, "evals"), join(WORKSPACE_ROOT, "corpus", "cases")];
// "codex+claude" detects with Codex and counter-reviews with Claude.
const agents = { codex: codexProvider, claude: claudeProvider, "codex+claude": codexProvider };

/** A case either has base/ and head/ trees beside it, or names a local repository and two revisions. */
type Label = {
  split: "dev" | "holdout";
  note: string;
  source?: { repository: string; base: string; head: string };
  // Another reviewer's comments on the same revisions, used to measure overlap with it.
  reference?: { reviewer: string; comments: Array<{ file: string; line: number; severity: string; title: string }> };
} & (
  | { kind: "regression"; locations: Array<{ file: string; lines: [number, number] }> }
  | { kind: "none" }
);

function parse(args: string[]) {
  const options = { agents: [] as Array<keyof typeof agents>, split: "dev", only: "", scoped: false, dryRun: false, maxParts: 4 };
  for (let index = 0; index < args.length; index += 1) {
    const [option, value] = [args[index], args[index + 1] ?? ""];
    if (option === "--scoped" || option === "--dry-run") {
      options[option === "--scoped" ? "scoped" : "dryRun"] = true;
      continue;
    }
    index += 1;
    if (option === "--max-parts" && /^\d+$/.test(value) && Number(value) > 0) options.maxParts = Number(value);
    else if (option === "--agent" && value in agents)
      options.agents.push(value as keyof typeof agents);
    else if (option === "--split" && ["dev", "holdout", "all"].includes(value))
      options.split = value;
    else if (option === "--case" && value) options.only = value;
    else if (option !== "--")
      throw new Error(
        "Usage: eval [--agent codex|claude|codex+claude]... [--split dev|holdout|all] [--case name] [--scoped] [--dry-run] [--max-parts N]\nRuns the labeled cases in evals/ with each agent (default: both, dev split).",
      );
    else index -= 1;
  }
  if (options.scoped && (!options.only || options.agents.length !== 1))
    throw new Error("Experimental --scoped requires exactly one --case and one --agent.");
  if (!options.agents.length) options.agents = ["codex", "claude"];
  return options;
}

/** Builds a two-commit repository from a case's base/ and head/ trees and returns its path. */
async function buildRepository(directory: string, name: string) {
  const root = await mkdtemp(join(tmpdir(), `auto-review-eval-${name}-`));
  const git = (...args: string[]) =>
    execFileSync("git", [
      "-C",
      root,
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ]);
  git("init", "--quiet", "-b", "main");
  git("config", "user.name", "AutoReview eval");
  git("config", "user.email", "eval@example.test");
  await cp(join(directory, "base"), root, { recursive: true });
  git("add", ".");
  git("commit", "--quiet", "-m", "base");
  await cp(join(directory, "head"), root, { recursive: true });
  git("add", ".");
  git("commit", "--quiet", "-m", "change");
  return root;
}

async function main() {
  const options = parse(process.argv.slice(2));
  const cases: Array<{ name: string; directory: string }> = [];
  for (const root of CASE_ROOTS) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries)
      if (entry.isDirectory() && (!options.only || entry.name === options.only))
        cases.push({ name: entry.name, directory: join(root, entry.name) });
  }
  cases.sort((a, b) => a.name.localeCompare(b.name));
  const results = [];
  for (const { name, directory } of cases) {
    const label: Label = JSON.parse(await readFile(join(directory, "case.json"), "utf8"));
    if (options.split !== "all" && label.split !== options.split) continue;
    const repository = label.source
      ? resolve(WORKSPACE_ROOT, label.source.repository)
      : await buildRepository(directory, name);
    const revisions = label.source ?? { base: "HEAD~1", head: "HEAD" };
    try {
      if (options.dryRun) {
        const summary = await withReviewContext(
          { repository, base: revisions.base, head: revisions.head },
          async (context, _checkout, sources) => {
            const plan = prepareDetection(context, options.scoped ? sources : undefined, options.maxParts);
            return { case: name, mode: plan.mode, scopeCount: plan.scopeCount, detectorPasses: plan.batches.length, validatorPasses: "0 or 1", payloadCharacters: plan.batches.map((batch) => JSON.stringify(batch).length), omittedContext: plan.context.omitted };
          },
        );
        process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
        continue;
      }
      for (const agent of options.agents) {
        console.error(`${name} with ${agent}...`);
        const started = Date.now();
        try {
          const report = await withReviewContext(
            { repository, base: revisions.base, head: revisions.head },
            (context, checkout, sources) =>
              review(context, agents[agent]({ checkout }), {
                checkout,
                scopedSources: options.scoped ? sources : undefined,
                maxParts: options.maxParts,
                validator: agent === "codex+claude" ? claudeProvider({ checkout }) : undefined,
              }),
          );
          const matches = (finding: { file: string; line: number }) =>
            label.kind === "regression" &&
            label.locations.some(
              (location) =>
                finding.file === location.file &&
                finding.line >= location.lines[0] &&
                finding.line <= location.lines[1],
            );
          const hit = report.findings.some(matches);
          // A reference comment counts as found when an accepted finding lands within 15 lines of it.
          const overlap = label.reference?.comments.map((comment) => ({
            ...comment,
            found: report.findings.some(
              (finding) => finding.file === comment.file && Math.abs(finding.line - comment.line) <= 15,
            ),
          }));
          // The detector saw the bug, but the citation check or counter-review withheld it.
          const withheld = report.records.some(
            (record) => record.verdict !== "accept" && matches(record.finding),
          );
          results.push({
            case: name,
            split: label.split,
            expected: label.kind,
            agent,
            // A suggestion for the human reviewer: matching location is not proof the finding is right.
            reference: overlap && {
              reviewer: label.reference!.reviewer,
              found: overlap.filter((comment) => comment.found).length,
              total: overlap.length,
              comments: overlap,
            },
            passes: report.passes.map(({ phase, durationMs, model, turns, toolCalls, usage }) => ({ phase, durationMs, model, turns, toolCalls, usage })),
            outcome:
              label.kind === "regression"
                ? hit
                  ? "found"
                  : withheld
                    ? "withheld"
                    : "missed"
                : report.findings.length
                  ? "false alarm?"
                  : "clean",
            extraFindings: report.findings.filter((finding) => !matches(finding)).length,
            findings: report.findings,
            status: report.status,
            detectionMode: report.detectionMode,
            scopeCount: report.scopeCount,
            coverage: report.coverage,
            withheld: report.records
              .filter((record) => record.verdict !== "accept")
              .map(({ finding, verdict, reason }) => ({
                file: finding.file,
                line: finding.line,
                title: finding.title,
                verdict,
                reason,
              })),
            durationMs: Date.now() - started,
            costUsd: report.passes.reduce<number | undefined>(
              (sum, pass) =>
                pass.usage?.costUsd === undefined ? sum : (sum ?? 0) + pass.usage.costUsd,
              undefined,
            ),
          });
        } catch (error) {
          results.push({
            case: name,
            split: label.split,
            expected: label.kind,
            agent,
            outcome: "error",
            error: error instanceof Error ? error.message : String(error),
            durationMs: Date.now() - started,
          });
        }
      }
    } finally {
      if (!label.source) await rm(repository, { recursive: true, force: true });
    }
  }
  if (options.dryRun) return;
  const destination = join(WORKSPACE_ROOT, "outputs", `eval-${Date.now()}.json`);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  const rows = results.map(
    (result) =>
      `| ${result.case} | ${result.split} | ${result.expected} | ${result.agent} | ${result.outcome} | ${"extraFindings" in result ? result.extraFindings : "-"} | ${(result.durationMs / 1000).toFixed(0)}s | ${"costUsd" in result && result.costUsd !== undefined ? `$${result.costUsd.toFixed(2)}` : "-"} | ${"reference" in result && result.reference ? `${result.reference.found}/${result.reference.total} of ${result.reference.reviewer}` : "-"} |`,
  );
  process.stdout.write(
    [
      "| Case | Split | Expected | Agent | Outcome | Extra findings | Time | Cost | Reference |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      ...rows,
      "",
      `Outcomes are location matches for a human to confirm. Full findings: ${destination}`,
      "",
    ].join("\n"),
  );
}

main().catch((error: unknown) => {
  console.error(`eval: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
