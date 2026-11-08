import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { Comment } from "./plan.js";

const exec = promisify(execFile);
const BUFFER = 50 * 1024 * 1024;

type ApiComment = {
  id: number;
  body: string;
  user: { login: string; type: string } | null;
  in_reply_to_id?: number;
  path?: string;
  line?: number | null;
};

const comment = (raw: ApiComment): Comment => ({
  id: raw.id,
  login: raw.user?.login ?? "ghost",
  bot: raw.user?.type === "Bot",
  body: raw.body ?? "",
  ...(raw.in_reply_to_id && { inReplyTo: raw.in_reply_to_id }),
  ...(raw.path && { path: raw.path, line: raw.line ?? null }),
});

async function get<T>(path: string) {
  const { stdout } = await exec("gh", ["api", "--paginate", "--slurp", path], {
    maxBuffer: BUFFER,
  });
  return (JSON.parse(stdout) as T[][]).flat();
}

/** Sends `body` as JSON on stdin, so long comments never meet the argument length limit. */
function send(method: string, path: string, body: object) {
  return new Promise<unknown>((accept, reject) => {
    const child = spawn("gh", ["api", "--method", method, path, "--input", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? accept(stdout ? JSON.parse(stdout) : undefined)
        : reject(new Error(`gh api ${method} ${path} failed: ${stderr.trim() || stdout.trim()}`)),
    );
    child.stdin.end(JSON.stringify(body));
  });
}

/** The pull request's current state, read through GitHub CLI. Without `target`, the current branch's. */
export async function pullRequest(target?: string, cwd?: string) {
  const { stdout } = await exec(
    "gh",
    [
      "pr",
      "view",
      ...(target ? [target] : []),
      "--json",
      "url,number,state,author,baseRefName,baseRefOid,headRefName,headRefOid",
    ],
    { cwd },
  );
  const raw = JSON.parse(stdout) as {
    url: string;
    number: number;
    state: string;
    author: { login: string };
    baseRefName: string;
    baseRefOid: string;
    headRefName: string;
    headRefOid: string;
  };
  const [, owner, name] = new URL(raw.url).pathname.split("/");
  return { ...raw, author: raw.author.login, repository: `${owner}/${name}` };
}
export type PullRequest = Awaited<ReturnType<typeof pullRequest>>;

/**
 * Fetches a pull request's base and head commits into `repository`, so a review covers exactly what
 * GitHub shows, including a pull request stacked on another branch. Creates no local branches.
 */
export async function fetchCommits(
  repository: string,
  pr: Pick<PullRequest, "url" | "number" | "baseRefName">,
) {
  const remote = `${pr.url.replace(/\/pull\/\d+$/, "")}.git`;
  await exec("git", [
    "-C",
    repository,
    "fetch",
    "--quiet",
    "--no-tags",
    remote,
    `refs/heads/${pr.baseRefName}`,
    `refs/pull/${pr.number}/head`,
  ]);
}

export const viewer = async () =>
  (await exec("gh", ["api", "user", "--jq", ".login"])).stdout.trim();

/** True for people who can push to the repository. Any lookup failure counts as no access. */
export async function canWrite(repository: string, login: string) {
  try {
    const { stdout } = await exec("gh", [
      "api",
      `repos/${repository}/collaborators/${encodeURIComponent(login)}/permission`,
      "--jq",
      ".permission",
    ]);
    return ["admin", "maintain", "write"].includes(stdout.trim());
  } catch {
    return false;
  }
}

export const conversation = async (pr: PullRequest) =>
  (await get<ApiComment>(`repos/${pr.repository}/issues/${pr.number}/comments`)).map(comment);
export const reviewComments = async (pr: PullRequest) =>
  (await get<ApiComment>(`repos/${pr.repository}/pulls/${pr.number}/comments`)).map(comment);
export const reviews = (pr: PullRequest) =>
  get<{ id: number; body: string; commit_id: string }>(
    `repos/${pr.repository}/pulls/${pr.number}/reviews`,
  );

/** Posts one review and returns its inline comments in the order they were sent. */
export async function postReview(
  pr: Pick<PullRequest, "repository" | "number">,
  body: { comments: Array<{ body: string }> },
) {
  const posted = (await send(
    "POST",
    `repos/${pr.repository}/pulls/${pr.number}/reviews`,
    body,
  )) as { id: number };
  const comments = await get<ApiComment>(
    `repos/${pr.repository}/pulls/${pr.number}/reviews/${posted.id}/comments`,
  );
  return body.comments.map((sent) => comments.find((made) => made.body === sent.body)?.id);
}

export const replyInThread = (pr: PullRequest, rootId: number, body: string) =>
  send("POST", `repos/${pr.repository}/pulls/${pr.number}/comments/${rootId}/replies`, { body });
export const replyInConversation = (pr: PullRequest, body: string) =>
  send("POST", `repos/${pr.repository}/issues/${pr.number}/comments`, { body });
export const acknowledge = (pr: PullRequest, commentId: number) =>
  send("POST", `repos/${pr.repository}/issues/comments/${commentId}/reactions`, {
    content: "eyes",
  });

/** Resolves the review thread that starts with `rootId`. Needs write access; returns false without it. */
export async function resolveThread(pr: PullRequest, rootId: number) {
  const [owner, name] = pr.repository.split("/");
  const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved comments(first:1){nodes{databaseId}}}}}}}`;
  try {
    const { stdout } = await exec(
      "gh",
      [
        "api",
        "graphql",
        "-f",
        `query=${query}`,
        "-f",
        `owner=${owner}`,
        "-f",
        `name=${name}`,
        "-F",
        `number=${pr.number}`,
      ],
      { maxBuffer: BUFFER },
    );
    const threads = JSON.parse(stdout).data.repository.pullRequest.reviewThreads.nodes as Array<{
      id: string;
      isResolved: boolean;
      comments: { nodes: Array<{ databaseId: number }> };
    }>;
    const thread = threads.find((candidate) => candidate.comments.nodes[0]?.databaseId === rootId);
    if (!thread) return false;
    if (thread.isResolved) return true;
    await exec("gh", [
      "api",
      "graphql",
      "-f",
      "query=mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}",
      "-f",
      `id=${thread.id}`,
    ]);
    return true;
  } catch {
    return false;
  }
}
