#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAgentSpec } from "./agent-spec.js";
import type { AgentName } from "./agent-spec.js";
import type { ModelProvider } from "./review/agent.js";
import { claudeProvider } from "./review/claude.js";
import { codexProvider } from "./review/codex.js";
import { batchContext } from "./review/context.js";
import { withReviewContext } from "./review/git.js";
import { prepareDetection, review } from "./review/run.js";

const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
// evals/ cases are committed and inline; corpus/cases/ point at local clones and stay git-ignored.
const CASE_ROOTS = [join(WORKSPACE_ROOT, "evals"), join(WORKSPACE_ROOT, "corpus", "cases")];
const agents: Record<AgentName, typeof codexProvider> = { codex: codexProvider, claude: claudeProvider };

/** A case either has base/ and head/ trees beside it, or names a local repository and two revisions. */
type Label = {
  split: "dev" | "holdout";
  note: string;
  source?: { repository: string; base: string; head: string };
  // Another reviewer's comments on the same revisions, used to measure overlap with it.
  // A comment may list extra anchors: other places the same bug can be reported (e.g. the implementation
  // when the reviewer commented at the call site). A finding within 15 lines of any anchor counts.
  // `needs` lists the head ranges a reviewer must see to find the bug; --context-recall checks the detector batches contain them.
  reference?: { reviewer: string; comments: Array<{ file: string; line: number; severity: string; title: string; anchors?: Array<{ file: string; line: number }>; needs?: Array<{ file: string; lines: [number, number]; why?: string }> }> };
} & (
  | { kind: "regression"; locations: Array<{ file: string; lines: [number, number] }> }
  | { kind: "none" }
);

function parse(args: string[]) {
  const options = { agents: [] as string[], split: "dev", only: "", replay: "", scoped: false, dryRun: false, detectorOnly: false, contextRecall: false, maxParts: 4 };
  for (let index = 0; index < args.length; index += 1) {
    const [option, value] = [args[index], args[index + 1] ?? ""];
    const flags = { "--scoped": "scoped", "--dry-run": "dryRun", "--detector-only": "detectorOnly", "--context-recall": "contextRecall" } as const;
    if (option in flags) {
      options[flags[option as keyof typeof flags]] = true;
      continue;
    }
    index += 1;
    if (option === "--max-parts" && /^\d+$/.test(value) && Number(value) > 0) options.maxParts = Number(value);
    else if (option === "--agent" && parseAgentSpec(value))
      options.agents.push(value);
    else if (option === "--split" && ["dev", "holdout", "all"].includes(value))
      options.split = value;
    else if (option === "--case" && value) options.only = value;
    else if (option === "--replay" && value) options.replay = value;
    else if (option !== "--")
      throw new Error(
        "Usage: eval [--agent detectors[+judge]]... [--split dev|holdout|all] [--case name] [--scoped] [--detector-only] [--context-recall] [--dry-run] [--max-parts N] [--replay output.json]\nRuns the labeled cases in evals/ with each agent spec (default: codex and claude, dev split).\nA spec lists comma-separated detectors (codex, claude; repeats allowed) that all run on every part, and an optional +judge that counter-reviews their candidates; without it findings are published at the detector's severity. Examples: codex, codex+claude, codex,claude+claude.\n--detector-only skips any judge and counts reference comments against every candidate, uncapped.\n--context-recall runs no model: it checks whether the head ranges each reference comment needs (its `needs`, else its own line) appear in a detector batch.\n--replay feeds the detector passes saved in an earlier eval output to the judge instead of running detectors; use the same case and --max-parts. Missing passes (a run cut short) are run live.",
      );
    else index -= 1;
  }
  if (options.scoped && (!options.only || options.agents.length !== 1))
    throw new Error("Experimental --scoped requires exactly one --case and one --agent.");
  if (!options.agents.length) options.agents = ["codex", "claude"];
  return options;
}

type SavedPass = { phase: string; agent?: string; survey?: unknown[]; candidates?: unknown[] };

/**
 * Serves saved detector passes in order, so a judge change can be measured without paying for
 * detection again. Once they run out, the real detectors take over in their usual rotation, so a
 * run cut short by a usage limit resumes from the first missing pass.
 */
function replayProvider(passes: SavedPass[], detectors: ModelProvider[]): ModelProvider {
  let served = 0;
  let live: ModelProvider | undefined;
  return {
    get name() {
      return live?.name ?? passes[Math.max(0, served - 1)]?.agent;
    },
    async complete(request) {
      const pass = passes[served++];
      if (pass) return { output: { survey: pass.survey ?? [], findings: pass.candidates ?? [] }, durationMs: 0 };
      live = detectors[(served - 1) % detectors.length]!;
      return live.complete(request);
    },
  };
}

/** Builds a two-commit repository from a case's base/ and head/ trees and returns its path. */
/** The detector passes an earlier eval output saved for a case, in the order they ran. */
async function loadReplay(path: string, caseName: string) {
  const results: Array<{ case: string; passes?: SavedPass[] }> = JSON.parse(await readFile(resolve(path), "utf8"));
  const result = results.find((entry) => entry.case === caseName);
  const passes = result?.passes?.filter((pass) => pass.phase === "detector") ?? [];
  if (!passes.length) throw new Error(`${path} has no detector passes for ${caseName}.`);
  if (passes.some((pass) => !pass.candidates)) throw new Error(`${path} predates per-pass candidates; it cannot be replayed.`);
  return passes;
}

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
      if (options.contextRecall) {
        const comments = label.reference?.comments ?? [];
        if (!comments.length) continue;
        const recall = await withReviewContext(
          { repository, base: revisions.base, head: revisions.head },
          async (context) => {
            // File-mode batches only; scoped batches carry their own excerpt shape.
            const batches = batchContext(context);
            const inBatch = (file: string, lines: [number, number]) =>
              batches.some(
                (batch) =>
                  batch.snippets.some((snippet) => snippet.revision === "head" && snippet.file === file && snippet.startLine <= lines[0] && snippet.endLine >= lines[1]) ||
                  batch.changes.some((change) => change.file === file && change.hunks.some((hunk) => hunk.newStart <= lines[0] && hunk.newStart + hunk.newLines - 1 >= lines[1])),
              );
            // Why a range is missing: the file was never indexed, the range was retrieved but dropped by
            // the budget, or no retrieval rule reached it at all.
            const omittedRanges = context.omitted.flatMap((entry) => {
              const match = /^(?:\w+:)?head:(.+):(\d+)-(\d+)$/.exec(entry);
              return match ? [{ file: match[1]!, start: Number(match[2]), end: Number(match[3]) }] : [];
            });
            const reason = (file: string, lines: [number, number]) =>
              context.skipped.includes(file)
                ? "skipped file"
                : context.snippets.some((snippet) => snippet.revision === "head" && snippet.file === file && snippet.startLine <= lines[1] && snippet.endLine >= lines[0])
                  ? "packed, dropped by the batch"
                  : omittedRanges.some((range) => range.file === file && range.start <= lines[1] && range.end >= lines[0])
                    ? "retrieved, dropped by the pack budget"
                    : "never retrieved";
            return comments.map((comment) => {
              // Without explicit needs, seeing the commented line itself (or any anchor) is enough.
              const around = (anchor: { file: string; line: number }) => ({ file: anchor.file, lines: [Math.max(1, anchor.line - 5), anchor.line + 5] as [number, number] });
              const anchors = [comment, ...(comment.anchors ?? [])].map(around);
              const needs = comment.needs ?? (anchors.some((need) => inBatch(need.file, need.lines)) ? [] : [anchors[0]!]);
              const missing = needs.filter((need) => !inBatch(need.file, need.lines)).map((need) => ({ ...need, reason: reason(need.file, need.lines) }));
              return { file: comment.file, line: comment.line, severity: comment.severity, visible: missing.length === 0, missing };
            });
          },
        );
        const visible = recall.filter((comment) => comment.visible).length;
        process.stdout.write(`${name}: ${visible}/${recall.length} comments fully visible to the detector\n`);
        for (const comment of recall.filter((entry) => !entry.visible))
          process.stdout.write(`  ${comment.severity} ${comment.file}:${comment.line} missing ${comment.missing.map((need) => `${need.file}:${need.lines[0]}-${need.lines[1]} (${need.reason})`).join(", ")}\n`);
        continue;
      }
      if (options.dryRun) {
        const summary = await withReviewContext(
          { repository, base: revisions.base, head: revisions.head },
          async (context, _checkout, sources) => {
            const plan = prepareDetection(context, options.scoped ? sources : undefined, options.maxParts);
            return { case: name, mode: plan.mode, scopeCount: plan.scopeCount, batches: plan.batches.length, payloadCharacters: plan.batches.map((batch) => JSON.stringify(batch).length), omittedContext: plan.context.omitted };
          },
        );
        for (const agent of options.agents) {
          const spec = parseAgentSpec(agent)!;
          const passes = { agent, detectorPasses: summary.batches * spec.detectors.length, validatorPasses: options.detectorOnly || !spec.judge ? 0 : "0 or 1" };
          process.stdout.write(`${JSON.stringify({ ...passes, ...summary }, null, 2)}\n`);
        }
        continue;
      }
      for (const agent of options.agents) {
        console.error(`${name} with ${agent}...`);
        const started = Date.now();
        // Detector passes that finished before a failure; reported on error so paid work is not lost.
        const completed: Array<{ phase: string; agent?: string; durationMs: number; model?: string; turns?: number; usage?: unknown; survey?: unknown[]; candidates: unknown[] }> = [];
        const spec = parseAgentSpec(agent)!;
        const replayed = options.replay ? await loadReplay(options.replay, name) : undefined;
        try {
          const report = await withReviewContext(
            { repository, base: revisions.base, head: revisions.head },
            (context, checkout, sources) =>
              review(context, replayed ? replayProvider(replayed, spec.detectors.map((detector) => agents[detector]({ checkout }))) : spec.detectors.map((detector) => agents[detector]({ checkout })), {
                checkout,
                scopedSources: options.scoped ? sources : undefined,
                maxParts: options.maxParts,
                validator: spec.judge && !options.detectorOnly ? agents[spec.judge]({ checkout }) : undefined,
                onPass: ({ phase, agent, durationMs, model, turns, usage, survey, candidates }) =>
                  completed.push({ phase, agent, durationMs, model, turns, usage, survey, candidates }),
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
          const proposed = report.records.some((record) => matches(record.finding));
          // A reference comment counts as found when an accepted finding lands within 15 lines of it,
          // or in detector-only mode any candidate, including ones the citation check rejected.
          const pool = options.detectorOnly ? report.records.map((record) => record.finding) : report.findings;
          const near = (comment: { file: string; line: number; anchors?: Array<{ file: string; line: number }> }, findings: Array<{ file: string; line: number }>) =>
            [comment, ...(comment.anchors ?? [])].some((anchor) =>
              findings.some((finding) => finding.file === anchor.file && Math.abs(finding.line - anchor.line) <= 15),
            );
          const overlap = label.reference?.comments.map((comment) => ({
            ...comment,
            found: near(comment, pool),
            // Accepted but held back by the severity cap, so the cap's cost stays visible.
            deferred: !near(comment, pool) && near(comment, report.deferred),
          }));
          // Recall per reference severity, so a missed High stands out from a missed Medium.
          const byLevel = overlap && Object.fromEntries(
            [...new Set(overlap.map((comment) => comment.severity))].map((level) => {
              const comments = overlap.filter((comment) => comment.severity === level);
              return [level, { found: comments.filter((comment) => comment.found).length, total: comments.length }];
            }),
          );
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
              deferred: overlap.filter((comment) => comment.deferred).length,
              byLevel,
              comments: overlap,
            },
            detectorOnly: options.detectorOnly,
            // Detector passes keep their candidates so a later --replay can rerun the judge alone.
            passes: report.passes.map(({ phase, agent, durationMs, model, turns, toolCalls, usage, survey }, index) => ({ phase, agent, durationMs, model, turns, toolCalls, usage, survey, candidates: completed[index]?.candidates })),
            outcome: options.detectorOnly
              ? label.kind === "regression"
                ? proposed
                  ? "proposed"
                  : "missed"
                : report.records.length
                  ? "proposed"
                  : "clean"
              : label.kind === "regression"
                ? hit
                  ? "found"
                  : withheld
                    ? "withheld"
                    : "missed"
                : report.findings.length
                  ? "false alarm?"
                  : "clean",
            candidates: report.records.length,
            extraFindings: report.findings.filter((finding) => !matches(finding)).length,
            extrasByLevel: Object.fromEntries(["critical", "high", "medium"].map((level) => [level, report.findings.filter((finding) => finding.severity === level && !matches(finding)).length])),
            findings: report.findings,
            deferred: report.deferred,
            status: report.status,
            detectionMode: report.detectionMode,
            scopeCount: report.scopeCount,
            coverage: report.coverage,
            withheld: report.records
              .filter((record) => record.verdict !== "accept")
              .map(({ agent, finding, verdict, reason }) => ({
                agent,
                file: finding.file,
                line: finding.line,
                title: finding.title,
                verdict,
                reason,
              })),
            // Every candidate with the detector that proposed it, accepted or not.
            proposed: report.records.map(({ agent, finding, verdict }) => ({ agent, file: finding.file, line: finding.line, title: finding.title, verdict })),
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
            passes: completed,
            durationMs: Date.now() - started,
          });
        }
      }
    } finally {
      if (!label.source) await rm(repository, { recursive: true, force: true });
    }
  }
  if (options.dryRun || options.contextRecall) return;
  const destination = join(WORKSPACE_ROOT, "outputs", `eval-${Date.now()}.json`);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  const rows = results.map(
    (result) =>
      `| ${result.case} | ${result.split} | ${result.expected} | ${result.agent} | ${result.outcome} | ${"candidates" in result ? result.candidates : "-"} | ${"extrasByLevel" in result && result.extrasByLevel ? `${result.extraFindings}${(result.extrasByLevel.high ?? 0) + (result.extrasByLevel.critical ?? 0) ? ` (${(result.extrasByLevel.high ?? 0) + (result.extrasByLevel.critical ?? 0)} high+)` : ""}` : "-"} | ${(result.durationMs / 1000).toFixed(0)}s | ${"costUsd" in result && result.costUsd !== undefined ? `$${result.costUsd.toFixed(2)}` : "-"} | ${"reference" in result && result.reference ? `${result.reference.found}/${result.reference.total} of ${result.reference.reviewer}${Object.entries(result.reference.byLevel ?? {}).map(([level, count]) => `, ${level} ${count.found}/${count.total}`).join("")}${result.reference.deferred ? `, ${result.reference.deferred} deferred` : ""}` : "-"} |`,
  );
  process.stdout.write(
    [
      "| Case | Split | Expected | Agent | Outcome | Candidates | Extra findings | Time | Cost | Reference |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
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
