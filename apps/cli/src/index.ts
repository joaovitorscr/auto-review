#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  PullRequestActivity,
  PullRequestAuthor,
  PullRequestCheck,
  PullRequestSnapshot,
} from "@auto-review/github";
import { withReviewContext } from "./review/git.js";
import { codexProvider } from "./review/codex.js";
import { claudeProvider } from "./review/claude.js";
import { review, renderReview } from "./review/run.js";
import { atLeast, reviewPayload } from "./review/post.js";
import { prover, renderVerification, verifyFinding } from "./review/verify.js";
import type { Verification } from "./review/verify.js";
import type { Finding } from "./review/findings.js";
import { indexRepository } from "./repository-index.js";
import * as github from "./watch/github.js";
import { watch } from "./watch/run.js";
import { avatarUrl, fileDiffUrl, parseArguments, repositoryName } from "./input.js";

const exec = promisify(execFile);
const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
// pnpm runs the CLI from apps/cli; INIT_CWD is where the user typed the command.
const INVOKED_FROM = process.env.INIT_CWD ?? process.cwd();
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

interface GhApiActivity {
  node_id: string;
  user?: {
    login: string;
    avatar_url: string;
  };
}

function actor(author: GhActor | undefined, exactAvatarUrl?: string): PullRequestAuthor {
  const login = author?.login ?? "ghost";
  return {
    login,
    ...(author?.name ? { name: author.name } : {}),
    avatarUrl: exactAvatarUrl ?? avatarUrl(login),
  };
}

function activityFrom(
  raw: GhPullRequest,
  avatarByActivityId: ReadonlyMap<string, string>,
): PullRequestActivity[] {
  return [
    ...raw.comments.map((comment) => ({
      id: comment.id,
      type: "comment" as const,
      author: actor(comment.author, avatarByActivityId.get(comment.id)),
      body: comment.body,
      url: comment.url,
      createdAt: comment.createdAt,
    })),
    ...raw.reviews.map((review) => ({
      id: review.id,
      type: "review" as const,
      author: actor(review.author, avatarByActivityId.get(review.id)),
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
  const [filesResult, commentsResult, reviewsResult] = await Promise.all([
    exec("gh", ["api", "--paginate", "--slurp", `repos/${repository}/pulls/${raw.number}/files`], {
      maxBuffer: 50 * 1024 * 1024,
    }),
    exec(
      "gh",
      ["api", "--paginate", "--slurp", `repos/${repository}/issues/${raw.number}/comments`],
      {
        maxBuffer: 50 * 1024 * 1024,
      },
    ),
    exec(
      "gh",
      ["api", "--paginate", "--slurp", `repos/${repository}/pulls/${raw.number}/reviews`],
      {
        maxBuffer: 50 * 1024 * 1024,
      },
    ),
  ]);
  const apiFiles = (JSON.parse(filesResult.stdout) as GhApiFile[][]).flat();
  const apiFileByPath = new Map(apiFiles.map((file) => [file.filename, file]));
  const apiActivity = [
    ...(JSON.parse(commentsResult.stdout) as GhApiActivity[][]).flat(),
    ...(JSON.parse(reviewsResult.stdout) as GhApiActivity[][]).flat(),
  ];
  const avatarByActivityId = new Map(
    apiActivity.flatMap((event) =>
      event.user?.avatar_url ? [[event.node_id, event.user.avatar_url] as const] : [],
    ),
  );
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
    activity: activityFrom(raw, avatarByActivityId),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    fetchedAt: new Date().toISOString(),
  };
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  if (args.command === "review") {
    const controller = new AbortController();
    const cancel = () => {
      if (controller.signal.aborted) process.exit(130);
      console.error("Cancelling review and cleaning up (press Ctrl-C again to force quit)...");
      controller.abort(new Error("Review cancelled."));
    };
    process.on("SIGINT", cancel).on("SIGTERM", cancel);
    const repository = resolve(INVOKED_FROM, args.repository);
    const pullRequest = args.pullRequest ? await github.pullRequest(args.pullRequest, repository) : undefined;
    if (pullRequest) await github.fetchCommits(repository, pullRequest);
    if (pullRequest) console.error(`Reviewing ${pullRequest.url}: ${pullRequest.headRefName} into ${pullRequest.baseRefName}`);
    console.error("Building review context...");
    await withReviewContext(
      {
        repository,
        base: pullRequest?.baseRefOid ?? args.base,
        head: pullRequest?.headRefOid ?? args.head,
        signal: controller.signal,
      },
      async (context, checkout) => {
        console.error(
          `${context.changes.length} changed JS/TS file(s), ${context.snippets.length} source range(s). ${context.workingTreeSnapshot ? "Reviewing a snapshot of uncommitted work; later edits are not included." : "Local edits are excluded."}`,
        );
        const save = async (result: object, label: string) => {
          const destination = args.output
            ? resolve(INVOKED_FROM, args.output)
            : resolve(
                WORKSPACE_ROOT,
                `outputs/review-${context.head.slice(0, 12)}-${Date.now()}.json`,
              );
          await mkdir(dirname(destination), { recursive: true });
          await writeFile(destination, `${JSON.stringify(result, null, 2)}\n`, "utf8");
          console.error(`Saved ${label} to ${destination}`);
        };
        if (args.dryRun) {
          if (args.output) await save(context, "review context");
          else process.stdout.write(`${JSON.stringify(context, null, 2)}\n`);
          return;
        }
        const provider = { name: args.agent, requestedModel: args.model ?? null };
        const agent = args.agent === "claude" ? claudeProvider : codexProvider;
        try {
          const result = await review(
            context,
            agent({ checkout, model: args.model, signal: controller.signal }),
            { onProgress: (message) => console.error(message), checkout },
          );
          await save({ ...result, provider, ...(pullRequest && { pullRequest: pullRequest.url }) }, "review report");
          process.stdout.write(renderReview(result));
        } catch (error) {
          const cancelled = controller.signal.aborted;
          await save(
            {
              version: 3,
              status: cancelled ? "cancelled" : "failed",
              base: context.base,
              head: context.head,
              workingTreeSnapshot: context.workingTreeSnapshot ?? false,
              error: error instanceof Error ? error.message : String(error),
              provider,
            },
            `${cancelled ? "cancelled" : "failed"} review record`,
          );
          if (cancelled) process.exitCode = 130;
          throw error;
        }
      },
    );
    return;
  }
  if (args.command === "verify") {
    const controller = new AbortController();
    const cancel = () => {
      if (controller.signal.aborted) process.exit(130);
      console.error("Cancelling verification and cleaning up (press Ctrl-C again to force quit)...");
      controller.abort(new Error("Verification cancelled."));
    };
    process.on("SIGINT", cancel).on("SIGTERM", cancel);
    const source = resolve(INVOKED_FROM, args.report);
    const destination = args.output ? resolve(INVOKED_FROM, args.output) : source.replace(/(\.verified)?\.json$/, ".verified.json");
    const report = JSON.parse(await readFile(source, "utf8")) as {
      status: string;
      base: string;
      head: string;
      workingTreeSnapshot?: boolean;
      findings: Array<Finding & { verification?: Verification }>;
    };
    if (report.status !== "complete" && report.status !== "partial") throw new Error(`Only a finished review can be verified; this report is ${report.status}.`);
    if (report.workingTreeSnapshot) throw new Error("This report reviewed uncommitted work. Review a commit with --head first.");
    const wanted = report.findings.filter((finding) => atLeast(finding, args.minimum) && !finding.verification);
    // One at a time: test runs need memory more than CPU, and a machine under pressure reads as false failures.
    for (const [index, finding] of wanted.entries()) {
      console.error(`Verifying ${index + 1} of ${wanted.length}: ${finding.title}`);
      finding.verification = await verifyFinding(finding, report, {
        repository: resolve(INVOKED_FROM, args.repository),
        provider: prover(args.model, controller.signal),
        signal: controller.signal,
      });
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      console.error(`Saved ${finding.verification.verdict} result to ${destination}`);
    }
    process.stdout.write(renderVerification(report.findings));
    return;
  }
  if (args.command === "watch") {
    const controller = new AbortController();
    const cancel = () => {
      if (controller.signal.aborted) process.exit(130);
      console.error("Stopping the watcher and cleaning up (press Ctrl-C again to force quit)...");
      controller.abort(new Error("Watch stopped."));
    };
    process.on("SIGINT", cancel).on("SIGTERM", cancel);
    await watch({ ...args, repository: resolve(INVOKED_FROM, args.repository), workspaceRoot: WORKSPACE_ROOT, signal: controller.signal });
    return;
  }
  if (args.command === "post") {
    const report = JSON.parse(await readFile(resolve(INVOKED_FROM, args.report), "utf8"));
    const payload = reviewPayload(report, args.minimum);
    // A report made with `review --pr` names its pull request, so it never lands on another repository's.
    const target = args.target ?? (report as { pullRequest?: string }).pullRequest;
    const pullRequest = await github.pullRequest(target);
    // Report lines belong to the reviewed commit; on any other head GitHub would misplace or reject them.
    if (pullRequest.headRefOid !== payload.commit_id)
      throw new Error(
        `The report reviewed ${payload.commit_id.slice(0, 12)}, but ${pullRequest.url} is at ${pullRequest.headRefOid.slice(0, 12)}. Review the pull request head again before posting.`,
      );
    if (args.dryRun) {
      process.stdout.write(`${JSON.stringify({ ...payload, posted: undefined }, null, 2)}\n`);
      return;
    }
    const { posted, ...body } = payload;
    await github.postReview(pullRequest, body);
    console.error(`Posted ${payload.comments.length} comment(s) to ${pullRequest.url}`);
    return;
  }
  const { target, output } = args;
  if (args.command === "index") {
    const index = await indexRepository(resolve(INVOKED_FROM, target ?? "."));
    const json = `${JSON.stringify(index, null, 2)}\n`;
    if (output) {
      const destination = resolve(INVOKED_FROM, output);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, json, "utf8");
      console.log(`Indexed ${index.files.length} files to ${destination}`);
    } else {
      process.stdout.write(json);
    }
    return;
  }
  const destination = resolve(WORKSPACE_ROOT, output);
  const snapshot = await fetchPullRequest(target);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  console.log(`Saved ${snapshot.repository}#${snapshot.number} to ${destination}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`auto-review: ${message}`);
  process.exitCode ||= 1;
});
