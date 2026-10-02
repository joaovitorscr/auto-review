#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeProvider } from "./review/claude.js";
import { codexProvider } from "./review/codex.js";
import { withReviewContext } from "./review/git.js";
import { review } from "./review/run.js";

const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CASES = join(WORKSPACE_ROOT, "evals");
const agents = { codex: codexProvider, claude: claudeProvider };

type Label =
  | {
      split: "dev" | "holdout";
      kind: "regression";
      file: string;
      lines: [number, number];
      note: string;
    }
  | { split: "dev" | "holdout"; kind: "none"; note: string };

function parse(args: string[]) {
  const options = { agents: [] as Array<keyof typeof agents>, split: "dev", only: "" };
  for (let index = 0; index < args.length; index += 1) {
    const [option, value] = [args[index], args[index + 1] ?? ""];
    index += 1;
    if (option === "--agent" && (value === "codex" || value === "claude"))
      options.agents.push(value);
    else if (option === "--split" && ["dev", "holdout", "all"].includes(value))
      options.split = value;
    else if (option === "--case" && value) options.only = value;
    else if (option !== "--")
      throw new Error(
        "Usage: eval [--agent codex|claude]... [--split dev|holdout|all] [--case name]\nRuns the labeled cases in evals/ with each agent (default: both, dev split).",
      );
    else index -= 1;
  }
  if (!options.agents.length) options.agents = ["codex", "claude"];
  return options;
}

/** Builds a two-commit repository from a case's base/ and head/ trees and returns its path. */
async function buildRepository(name: string) {
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
  await cp(join(CASES, name, "base"), root, { recursive: true });
  git("add", ".");
  git("commit", "--quiet", "-m", "base");
  await cp(join(CASES, name, "head"), root, { recursive: true });
  git("add", ".");
  git("commit", "--quiet", "-m", "change");
  return root;
}

async function main() {
  const options = parse(process.argv.slice(2));
  const names = (await readdir(CASES, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && (!options.only || entry.name === options.only))
    .map((entry) => entry.name)
    .sort();
  const results = [];
  for (const name of names) {
    const label: Label = JSON.parse(await readFile(join(CASES, name, "case.json"), "utf8"));
    if (options.split !== "all" && label.split !== options.split) continue;
    const repository = await buildRepository(name);
    try {
      for (const agent of options.agents) {
        console.error(`${name} with ${agent}...`);
        const started = Date.now();
        try {
          const report = await withReviewContext(
            { repository, base: "HEAD~1", head: "HEAD" },
            (context, checkout) => review(context, agents[agent]({ checkout })),
          );
          const matches = (finding: (typeof report.findings)[number]) =>
            label.kind === "regression" &&
            finding.file === label.file &&
            finding.line >= label.lines[0] &&
            finding.line <= label.lines[1];
          const hit = report.findings.some(matches);
          results.push({
            case: name,
            split: label.split,
            expected: label.kind,
            agent,
            // A suggestion for the human reviewer: matching location is not proof the finding is right.
            outcome:
              label.kind === "regression"
                ? hit
                  ? "found"
                  : "missed"
                : report.findings.length
                  ? "false alarm?"
                  : "clean",
            extraFindings: report.findings.filter((finding) => !matches(finding)).length,
            findings: report.findings,
            withheld: report.records.filter((record) => record.verdict !== "accept").length,
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
      await rm(repository, { recursive: true, force: true });
    }
  }
  const destination = join(WORKSPACE_ROOT, "outputs", `eval-${Date.now()}.json`);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  const rows = results.map(
    (result) =>
      `| ${result.case} | ${result.split} | ${result.expected} | ${result.agent} | ${result.outcome} | ${"extraFindings" in result ? result.extraFindings : "-"} | ${(result.durationMs / 1000).toFixed(0)}s | ${"costUsd" in result && result.costUsd !== undefined ? `$${result.costUsd.toFixed(2)}` : "-"} |`,
  );
  process.stdout.write(
    [
      "| Case | Split | Expected | Agent | Outcome | Extra findings | Time | Cost |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
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
