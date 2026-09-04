#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import type { PullRequestCheck, PullRequestSnapshot } from "@auto-review/github";

const exec = promisify(execFile);
const DEFAULT_OUTPUT = "apps/web/public/pr.json";
const FIELDS = [
  "additions",
  "author",
  "baseRefName",
  "body",
  "changedFiles",
  "commits",
  "deletions",
  "files",
  "headRefName",
  "isDraft",
  "number",
  "state",
  "statusCheckRollup",
  "title",
  "url",
].join(",");

interface GhPullRequest {
  additions: number;
  author: { login: string; name?: string; avatarUrl: string };
  baseRefName: string;
  body: string;
  changedFiles: number;
  commits: unknown[];
  deletions: number;
  files: Array<{ path: string; additions: number; deletions: number }>;
  headRefName: string;
  isDraft: boolean;
  number: number;
  state: string;
  statusCheckRollup: Array<Record<string, unknown>>;
  title: string;
  url: string;
}

function usage(): string {
  return `Usage: auto-review snapshot [number-or-url] [--output path]\n\nFetches a pull request with GitHub CLI and writes a JSON snapshot.\nIf number-or-url is omitted, gh uses the pull request for the current branch.`;
}

function parseArguments(args: string[]): { target?: string; output: string } {
  const [command, ...rest] = args;
  if (command !== "snapshot") {
    throw new Error(command ? `Unknown command: ${command}\n\n${usage()}` : usage());
  }

  let target: string | undefined;
  let output = DEFAULT_OUTPUT;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--output" || argument === "-o") {
      const value = rest[index + 1];
      if (!value) throw new Error(`${argument} needs a path`);
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
  return { target, output };
}

function checkFrom(raw: Record<string, unknown>): PullRequestCheck {
  const state = String(raw.conclusion ?? raw.state ?? raw.status ?? "UNKNOWN");
  return {
    name: String(raw.name ?? raw.context ?? "Unknown check"),
    state,
    ...(raw.workflowName ? { workflow: String(raw.workflowName) } : {}),
    ...(raw.detailsUrl || raw.targetUrl ? { url: String(raw.detailsUrl ?? raw.targetUrl) } : {}),
  };
}

async function repositoryName(): Promise<string> {
  const { stdout } = await exec("gh", [
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "--jq",
    ".nameWithOwner",
  ]);
  return stdout.trim();
}

async function fetchPullRequest(target?: string): Promise<PullRequestSnapshot> {
  const args = ["pr", "view"];
  if (target) args.push(target);
  args.push("--json", FIELDS);

  const [{ stdout }, repository] = await Promise.all([
    exec("gh", args, { maxBuffer: 10 * 1024 * 1024 }),
    repositoryName(),
  ]);
  const raw = JSON.parse(stdout) as GhPullRequest;
  return {
    repository,
    number: raw.number,
    title: raw.title,
    body: raw.body,
    url: raw.url,
    state: raw.state,
    isDraft: raw.isDraft,
    author: raw.author,
    baseRefName: raw.baseRefName,
    headRefName: raw.headRefName,
    additions: raw.additions,
    deletions: raw.deletions,
    changedFiles: raw.changedFiles,
    commits: raw.commits.length,
    files: raw.files,
    checks: raw.statusCheckRollup.map(checkFrom),
    fetchedAt: new Date().toISOString(),
  };
}

async function main(): Promise<void> {
  const { target, output } = parseArguments(process.argv.slice(2));
  const destination = resolve(output);
  const snapshot = await fetchPullRequest(target);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  console.log(`Saved ${snapshot.repository}#${snapshot.number} to ${destination}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`auto-review: ${message}`);
  process.exitCode = 1;
});
