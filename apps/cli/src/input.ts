import { createHash } from "node:crypto";
import { parseReviewArguments } from "./review/input.js";

const DEFAULT_OUTPUT = "apps/web/public/pr.json";

export function usage(): string {
  return `Usage: auto-review snapshot [number-or-url] [--output path]\n       auto-review index [repository-path] [--output path]\n       auto-review review (--pr number-or-url | --base ref [--head ref]) [--repo path] [--agent codex|claude] [--model id] [--output report.json] [--dry-run]\n       auto-review verify report.json --repo path [--min high|medium] [--model id] [--output report.json]\n       auto-review post report.json [number-or-url] [--min high|medium] [--dry-run]\n       auto-review watch number-or-url --repo path [--agent codex|claude] [--model id] [--min high|medium] [--dry-run]\n\nReview runs Codex (default) or Claude Code against JS/TS changes. --pr fetches that pull request's base and head into --repo and reviews exactly that, and post then knows where to post. Without --pr or --head it includes uncommitted and untracked files. --dry-run writes context without invoking an agent.\n\nVerify has a Claude Code agent prove each saved finding at --min severity or above (default high) with a test, one at a time, then reruns the test itself. It runs the pull request's code on this machine with no prompts, so use it only on code you trust. It saves to --output (default: beside the report, ending .verified.json) after each finding, and a rerun on that file skips finished findings.\n\nPost publishes a verified report's proven findings at --min severity or above (default high) as one pull request review, through GitHub CLI. Without number-or-url it posts to the pull request the report reviewed with --pr, else the current branch's. The report must have reviewed the pull request's current head commit. --dry-run prints the review instead of posting it.\n\nWatch keeps one pull request reviewed from this machine until it closes, checking it every minute. On each push it reruns the tests behind open findings and resolves the threads they now pass on, then reviews the new commits, proves findings as verify does and posts them as post does. It answers replies on its threads, and a conversation comment starting with /auto-review runs a full review. Only you and people with write access can trigger it; others get a refusal. Pushes are reviewed unprompted only when the pull request's author has write access, because proving runs the pull request's code here. --repo is a local clone of the repository. --dry-run prints one pass's decisions without running an agent or posting.\n\nIndex writes a local Git checkout AST as JSON to stdout or --output.\n\nSnapshot fetches a pull request with GitHub CLI and writes a JSON snapshot.\nIf number-or-url is omitted, gh uses the pull request for the current branch.`;
}

export function parseArguments(args: string[]) {
  const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
  const [command, ...rest] = normalizedArgs;
  if (command === "review") return parseReviewArguments(rest);
  if (command === "post") return parsePostArguments(rest);
  if (command === "verify") return parseVerifyArguments(rest);
  if (command === "watch") return parseWatchArguments(rest);
  if (command !== "snapshot" && command !== "index") {
    throw new Error(command ? `Unknown command: ${command}\n\n${usage()}` : usage());
  }

  let target: string | undefined;
  let output = command === "index" ? "" : DEFAULT_OUTPUT;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--output" || argument === "-o") {
      const value = rest[index + 1];
      if (!value || value.startsWith("-")) throw new Error(`${argument} needs a path`);
      output = value;
      index += 1;
    } else if (argument?.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`);
    } else if (target) {
      throw new Error(`Unexpected argument: ${argument}`);
    } else {
      target = argument;
    }
  }
  return { command, target, output } as const;
}

function parsePostArguments(args: string[]) {
  const positional: string[] = [];
  let minimum: "high" | "medium" = "high";
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--dry-run") dryRun = true;
    else if (argument === "--min") {
      const value = args[++index];
      if (value !== "high" && value !== "medium") throw new Error("--min must be high or medium");
      minimum = value;
    } else if (argument.startsWith("-")) throw new Error(`Unknown post option: ${argument}`);
    else positional.push(argument);
  }
  const [report, target, extra] = positional;
  if (!report) throw new Error("post needs a saved review report: post report.json [number-or-url]");
  if (extra) throw new Error(`Unexpected argument: ${extra}`);
  return { command: "post" as const, report, target, minimum, dryRun };
}

function parseVerifyArguments(args: string[]) {
  let report: string | undefined;
  let repository = "";
  let minimum: "high" | "medium" = "high";
  let model: string | undefined;
  let output = "";
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!argument.startsWith("-")) {
      if (report) throw new Error(`Unexpected argument: ${argument}`);
      report = argument;
      continue;
    }
    if (!["--repo", "--min", "--model", "--output", "-o"].includes(argument)) throw new Error(`Unknown verify option: ${argument}`);
    const value = args[++index];
    if (!value || value.startsWith("-")) throw new Error(`${argument} needs a value`);
    if (argument === "--repo") repository = value;
    else if (argument === "--model") model = value;
    else if (argument === "--min") {
      if (value !== "high" && value !== "medium") throw new Error("--min must be high or medium");
      minimum = value;
    } else output = value;
  }
  if (!report) throw new Error("verify needs a saved review report: verify report.json --repo path");
  if (!repository) throw new Error("verify needs --repo, the repository the report reviewed");
  return { command: "verify" as const, report, repository, minimum, model, output };
}

function parseWatchArguments(args: string[]) {
  let target: string | undefined;
  let repository = ".";
  let agent: "codex" | "claude" = "codex";
  let model: string | undefined;
  let minimum: "high" | "medium" = "high";
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (!argument.startsWith("-")) {
      if (target) throw new Error(`Unexpected argument: ${argument}`);
      target = argument;
      continue;
    }
    if (!["--repo", "--agent", "--model", "--min"].includes(argument)) throw new Error(`Unknown watch option: ${argument}`);
    const value = args[++index];
    if (!value || value.startsWith("-")) throw new Error(`${argument} needs a value`);
    if (argument === "--repo") repository = value;
    else if (argument === "--model") model = value;
    else if (argument === "--agent") {
      if (value !== "codex" && value !== "claude") throw new Error(`--agent must be codex or claude, not ${value}`);
      agent = value;
    } else {
      if (value !== "high" && value !== "medium") throw new Error("--min must be high or medium");
      minimum = value;
    }
  }
  if (!target) throw new Error("watch needs a pull request: watch number-or-url --repo path");
  return { command: "watch" as const, target, repository, agent, model, minimum, dryRun };
}

export function repositoryName(url: string): string {
  const [, owner, repository] = new URL(url).pathname.split("/");
  if (!owner || !repository) throw new Error(`Could not read repository from PR URL: ${url}`);
  return `${owner}/${repository}`;
}

export function avatarUrl(login: string): string {
  return `https://github.com/${encodeURIComponent(login)}.png?size=80`;
}

export function fileDiffUrl(pullRequestUrl: string, path: string): string {
  const anchor = createHash("sha256").update(path).digest("hex");
  return `${pullRequestUrl}/files#diff-${anchor}`;
}
