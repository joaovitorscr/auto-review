#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { PullRequestCheck, PullRequestSnapshot } from "@auto-review/github";
import { avatarUrl, fileDiffUrl, parseArguments, repositoryName } from "./input.js";

const exec = promisify(execFile);
const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
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
  author: { login: string; name?: string };
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

function checkFrom(raw: Record<string, unknown>): PullRequestCheck {
  const state = String(raw.conclusion ?? raw.state ?? raw.status ?? "UNKNOWN");
  return {
    name: String(raw.name ?? raw.context ?? "Unknown check"),
    state,
    ...(raw.workflowName ? { workflow: String(raw.workflowName) } : {}),
    ...(raw.detailsUrl || raw.targetUrl ? { url: String(raw.detailsUrl ?? raw.targetUrl) } : {}),
  };
}

async function fetchPullRequest(target?: string): Promise<PullRequestSnapshot> {
  const args = ["pr", "view"];
  if (target) args.push(target);
  args.push("--json", FIELDS);

  const { stdout } = await exec("gh", args, { maxBuffer: 10 * 1024 * 1024 });
  const raw = JSON.parse(stdout) as GhPullRequest;
  return {
    repository: repositoryName(raw.url),
    number: raw.number,
    title: raw.title,
    body: raw.body,
    url: raw.url,
    state: raw.state,
    isDraft: raw.isDraft,
    author: {
      login: raw.author.login,
      ...(raw.author.name ? { name: raw.author.name } : {}),
      avatarUrl: avatarUrl(raw.author.login),
    },
    baseRefName: raw.baseRefName,
    headRefName: raw.headRefName,
    additions: raw.additions,
    deletions: raw.deletions,
    changedFiles: raw.changedFiles,
    commits: raw.commits.length,
    files: raw.files.map((file) => ({
      ...file,
      diffUrl: fileDiffUrl(raw.url, file.path),
    })),
    checks: raw.statusCheckRollup.map(checkFrom),
    fetchedAt: new Date().toISOString(),
  };
}

async function main(): Promise<void> {
  const { target, output } = parseArguments(process.argv.slice(2));
  const destination = resolve(WORKSPACE_ROOT, output);
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
