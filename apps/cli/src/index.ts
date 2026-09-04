#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  PullRequestActivity,
  PullRequestAuthor,
  PullRequestCheck,
  PullRequestSnapshot,
} from "@auto-review/github";
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
  "comments",
  "createdAt",
  "deletions",
  "files",
  "headRefName",
  "isDraft",
  "labels",
  "number",
  "state",
  "statusCheckRollup",
  "title",
  "reviews",
  "updatedAt",
  "url",
].join(",");

interface GhPullRequest {
  additions: number;
  author: { login: string; name?: string };
  baseRefName: string;
  body: string;
  changedFiles: number;
  comments: GhComment[];
  commits: GhCommit[];
  createdAt: string;
  deletions: number;
  files: Array<{ path: string; additions: number; deletions: number }>;
  headRefName: string;
  isDraft: boolean;
  labels: Array<{ name: string; color: string }>;
  reviews: GhReview[];
  number: number;
  state: string;
  statusCheckRollup: Array<Record<string, unknown>>;
  title: string;
  updatedAt: string;
  url: string;
}

interface GhActor {
  login: string;
  name?: string;
}

interface GhComment {
  id: string;
  author: GhActor;
  body: string;
  createdAt: string;
  url: string;
}

interface GhReview {
  id: string;
  author: GhActor;
  body: string;
  submittedAt: string;
  state: string;
  commit?: { oid: string };
}

interface GhCommit {
  oid: string;
  messageHeadline: string;
  messageBody: string;
  committedDate: string;
  authors: GhActor[];
}

interface GhApiFile {
  filename: string;
  status: string;
  patch?: string;
}

function actor(author: GhActor | undefined): PullRequestAuthor {
  const login = author?.login ?? "ghost";
  return {
    login,
    ...(author?.name ? { name: author.name } : {}),
    avatarUrl: avatarUrl(login),
  };
}

function activityFrom(raw: GhPullRequest): PullRequestActivity[] {
  return [
    ...raw.comments.map((comment) => ({
      id: comment.id,
      type: "comment" as const,
      author: actor(comment.author),
      body: comment.body,
      url: comment.url,
      createdAt: comment.createdAt,
    })),
    ...raw.reviews.map((review) => ({
      id: review.id,
      type: "review" as const,
      author: actor(review.author),
      body: review.body,
      state: review.state,
      createdAt: review.submittedAt,
      ...(review.commit ? { commitOid: review.commit.oid } : {}),
    })),
    ...raw.commits.map((commit) => ({
      id: commit.oid,
      type: "commit" as const,
      author: actor(commit.authors[0]),
      body: [commit.messageHeadline, commit.messageBody].filter(Boolean).join("\n\n"),
      createdAt: commit.committedDate,
      commitOid: commit.oid,
    })),
  ].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
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
  const repository = repositoryName(raw.url);
  const { stdout: filesStdout } = await exec(
    "gh",
    ["api", "--paginate", "--slurp", `repos/${repository}/pulls/${raw.number}/files`],
    { maxBuffer: 50 * 1024 * 1024 },
  );
  const apiFiles = (JSON.parse(filesStdout) as GhApiFile[][]).flat();
  const apiFileByPath = new Map(apiFiles.map((file) => [file.filename, file]));
  return {
    repository,
    number: raw.number,
    title: raw.title,
    body: raw.body,
    url: raw.url,
    state: raw.state,
    isDraft: raw.isDraft,
    author: actor(raw.author),
    baseRefName: raw.baseRefName,
    headRefName: raw.headRefName,
    additions: raw.additions,
    deletions: raw.deletions,
    changedFiles: raw.changedFiles,
    commits: raw.commits.length,
    files: raw.files.map((file) => ({
      ...file,
      diffUrl: fileDiffUrl(raw.url, file.path),
      status: apiFileByPath.get(file.path)?.status,
      patch: apiFileByPath.get(file.path)?.patch,
    })),
    checks: raw.statusCheckRollup.map(checkFrom),
    labels: raw.labels,
    activity: activityFrom(raw),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
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
