import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { claudeProvider } from "../review/claude.js";
import { codexProvider } from "../review/codex.js";
import { withReviewContext } from "../review/git.js";
import { POSTED_MARKER, reviewPayload, signed } from "../review/post.js";
import { review } from "../review/run.js";
import {
  prover,
  recheckProofs,
  savedProof,
  verifyFinding,
  withDisposableCheckout,
} from "../review/verify.js";
import type { Verification } from "../review/verify.js";
import * as github from "./github.js";
import {
  decide,
  fixedMessage,
  initialState,
  parseReply,
  pending,
  REFUSAL,
  replyPrompt,
  replySchema,
  reviewedMessage,
  withoutOpenThreads,
} from "./plan.js";
import type { Comment, WatchState } from "./plan.js";

const exec = promisify(execFile);
const POLL_MS = 60_000;
const rank = { critical: 0, high: 1, medium: 2, low: 3 };

const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((done) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), done()), { once: true });
  });

async function isAncestor(repository: string, ancestor: string, commit: string) {
  try {
    await exec("git", ["-C", repository, "merge-base", "--is-ancestor", ancestor, commit]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Watches one pull request from this machine until it closes: reviews new pushes, answers replies on
 * AutoReview's threads, and runs a review when a trusted person comments `/auto-review`. Everything is
 * posted as the GitHub CLI user, and inference runs through the local agent. State is saved under
 * outputs/watch, so a restart neither repeats answers nor re-reviews a head.
 */
export async function watch(options: {
  target: string;
  repository: string;
  agent: "codex" | "claude";
  model?: string;
  minimum: "high" | "medium";
  dryRun: boolean;
  workspaceRoot: string;
  signal: AbortSignal;
}) {
  const { repository, signal } = options;
  const log = (message: string) => console.error(`[${new Date().toLocaleTimeString()}] ${message}`);
  const reader = (checkout: string) =>
    options.agent === "claude"
      ? claudeProvider({ checkout, model: options.model, signal })
      : codexProvider({ checkout, model: options.model, signal });
  const self = await github.viewer();
  let pr = await github.pullRequest(options.target, repository);
  const statePath = join(
    options.workspaceRoot,
    "outputs/watch",
    `${pr.repository.replace("/", "-")}-${pr.number}.json`,
  );
  let state: WatchState;
  try {
    state = JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    const [conversation, comments, reviews] = await Promise.all([
      github.conversation(pr),
      github.reviewComments(pr),
      github.reviews(pr),
    ]);
    state = initialState([...conversation, ...comments], reviews);
  }
  const save = async () => {
    if (options.dryRun) return;
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  };
  const access = new Map([[self, true]]);
  const trusted = async (login: string) => {
    if (!access.has(login)) access.set(login, await github.canWrite(pr.repository, login));
    return access.get(login)!;
  };
  log(
    `Watching ${pr.url} as ${self}. ${options.dryRun ? "Dry run: one pass, nothing posted." : "Ctrl-C stops."}`,
  );

  /** Reruns open proofs at the new head, then reviews what changed since the last reviewed head. */
  async function cycle(command?: Comment) {
    const head = pr.headRefOid;
    state.attemptedHead = head;
    await save();
    await github.fetchCommits(repository, pr);
    const open = state.threads.filter((thread) => thread.proof && !thread.fixedIn);
    if (open.length) {
      log(`Rerunning ${open.length} open finding(s)' tests at ${head.slice(0, 10)}...`);
      const results = await recheckProofs(
        repository,
        head,
        open.map((thread) => thread.proof!),
        signal,
      );
      for (const [index, thread] of open.entries()) {
        if (results[index] !== "fixed") continue;
        await github.replyInThread(pr, thread.rootId, signed(fixedMessage(head, thread.proof!)));
        if (!(await github.resolveThread(pr, thread.rootId)))
          log(`Could not resolve the thread for "${thread.title}"; it needs write access.`);
        thread.fixedIn = head;
        log(`Fixed: ${thread.title}`);
      }
      await save();
    }

    const incremental =
      !command &&
      state.reviewedHead &&
      state.reviewedHead !== head &&
      (await isAncestor(repository, state.reviewedHead, head));
    const base = incremental ? state.reviewedHead! : pr.baseRefOid;
    log(
      `Reviewing ${incremental ? `commits since ${base.slice(0, 10)}` : "the whole pull request"}...`,
    );
    const report = await withReviewContext(
      { repository, base, head, signal },
      (context, checkout) => review(context, reader(checkout), { onProgress: log, checkout }),
    );
    const fixed = new Set(
      state.threads.flatMap((thread) => (thread.fixedIn ? [thread.rootId] : [])),
    );
    const threads = (await github.reviewComments(pr)).filter(
      (comment) =>
        !comment.inReplyTo && comment.body.includes(POSTED_MARKER) && !fixed.has(comment.id),
    );
    const findings: Array<(typeof report.findings)[number] & { verification?: Verification }> =
      withoutOpenThreads(report.findings, threads).filter(
        (finding) => rank[finding.severity] <= rank[options.minimum],
      );
    const verified = {
      ...report,
      findings,
      provider: { name: options.agent, requestedModel: options.model ?? null },
      pullRequest: pr.url,
    };
    // Saved before and after proving, so a failed proof never loses the paid review.
    const reportPath = join(
      options.workspaceRoot,
      "outputs",
      `review-${head.slice(0, 12)}-${Date.now()}.verified.json`,
    );
    const saveReport = async () => {
      await mkdir(dirname(reportPath), { recursive: true });
      await writeFile(reportPath, `${JSON.stringify(verified, null, 2)}\n`, "utf8");
    };
    await saveReport();
    for (const [index, finding] of findings.entries()) {
      log(`Proving ${index + 1} of ${findings.length}: ${finding.title}`);
      finding.verification = await verifyFinding(finding, report, {
        repository,
        provider: prover(options.model, signal),
        signal,
      });
      log(`${finding.verification.verdict}: ${finding.verification.reason}`);
      await saveReport();
    }
    log(`Saved the report to ${reportPath}`);

    const payload = reviewPayload(verified, options.minimum);
    if (payload) {
      // Report lines belong to the reviewed commit; on any other head GitHub would misplace them.
      if ((await github.pullRequest(pr.url)).headRefOid !== head)
        return log("The pull request moved during the review; the next pass reviews its new head.");
      const { posted, ...body } = payload;
      const ids = await github.postReview(pr, body);
      for (const [index, finding] of posted.entries()) {
        const rootId = ids[index];
        const proof = savedProof(finding.verification);
        if (rootId)
          state.threads.push({
            rootId,
            file: finding.file,
            title: finding.title,
            ...(proof && { proof }),
          });
      }
      log(`Posted ${posted.length} finding(s).`);
    }
    state.reviewedHead = head;
    await save();
    if (command)
      await github.replyInConversation(
        pr,
        signed(reviewedMessage(head, options.minimum, payload?.posted.length ?? 0)),
      );
  }

  async function answer(root: Comment, reply: Comment, comments: Comment[]) {
    log(`Answering @${reply.login} on ${root.path}...`);
    const thread = [
      root,
      ...comments
        .filter((comment) => comment.inReplyTo === root.id && comment.id <= reply.id)
        .sort((left, right) => left.id - right.id),
    ];
    await github.fetchCommits(repository, pr);
    const proof = state.threads.find((tracked) => tracked.rootId === root.id)?.proof;
    const response = await withDisposableCheckout(repository, pr.headRefOid, (checkout) =>
      reader(checkout).complete({
        prompt: replyPrompt(thread, pr.headRefOid, proof),
        schema: replySchema,
      }),
    );
    const { reply: text, resolve } = parseReply(response.output);
    await github.replyInThread(pr, root.id, signed(text));
    if (resolve && !(await github.resolveThread(pr, root.id)))
      log("Could not resolve the thread; it needs write access.");
  }

  /** Runs one action of a pass; a failure is logged so the pass's other requests still get their turn. */
  async function attempt(
    what: string,
    action: () => Promise<unknown>,
    onFailure?: () => Promise<unknown>,
  ) {
    try {
      await action();
    } catch (error) {
      if (signal.aborted) throw error;
      log(`${what} failed: ${error instanceof Error ? error.message : String(error)}`);
      await onFailure?.().catch(() => {});
    }
  }

  async function pass() {
    pr = await github.pullRequest(pr.url);
    if (pr.state !== "OPEN") return false;
    const [conversation, comments] = await Promise.all([
      github.conversation(pr),
      github.reviewComments(pr),
    ]);
    for (const comment of pending(state, [...conversation, ...comments]))
      await trusted(comment.login);
    const plan = decide({
      state,
      head: pr.headRefOid,
      authorTrusted: await trusted(pr.author),
      conversation,
      reviewComments: comments,
      trusted: new Set([...access].flatMap(([login, ok]) => (ok ? [login] : []))),
    });
    if (options.dryRun) {
      const ids = (list: Array<{ comment?: Comment; reply?: Comment }>) =>
        list.map((item) => (item.comment ?? item.reply)!.id);
      process.stdout.write(
        `${JSON.stringify({ pullRequest: pr.url, head: pr.headRefOid, author: pr.author, authorTrusted: access.get(pr.author), state, review: plan.review ? { command: plan.review.command?.id ?? null } : null, answer: ids(plan.answer), refuse: ids(plan.refuse) }, null, 2)}\n`,
      );
      return false;
    }
    // Marked before acting, so a crash mid-pass never posts the same answer twice.
    state.handled.push(...plan.handled);
    await save();
    for (const { comment, root } of plan.refuse) {
      log(`Refusing @${comment.login}: no write access.`);
      await (root
        ? github.replyInThread(pr, root.id, signed(REFUSAL))
        : github.replyInConversation(pr, signed(REFUSAL)));
    }
    if (plan.review) {
      const { command } = plan.review;
      if (command) await github.acknowledge(pr, command.id);
      await attempt(
        "The review",
        () => cycle(command),
        async () => {
          if (command)
            await github.replyInConversation(
              pr,
              signed(
                `Review of ${pr.headRefOid.slice(0, 10)} failed. The watcher's terminal has the details.`,
              ),
            );
        },
      );
    }
    for (const { root, reply } of plan.answer)
      await attempt(`The answer to @${reply.login}`, () => answer(root, reply, comments));
    return true;
  }

  while (!signal.aborted) {
    try {
      if (!(await pass())) break;
    } catch (error) {
      if (signal.aborted) break;
      log(`This pass failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await pause(POLL_MS, signal);
  }
  if (!options.dryRun && pr.state !== "OPEN")
    log(`${pr.url} is ${pr.state.toLowerCase()}; stopped watching.`);
}
