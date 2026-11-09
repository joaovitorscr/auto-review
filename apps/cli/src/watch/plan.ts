import { POSTED_MARKER } from "../review/post.js";
import type { Finding } from "../review/findings.js";
import type { SavedProof } from "../review/verify.js";

/** A pull request comment: a conversation comment, or an inline one when `path` is set. */
export type Comment = {
  id: number;
  login: string;
  bot: boolean;
  body: string;
  inReplyTo?: number;
  path?: string;
  line?: number | null;
};

/** A finding AutoReview posted, kept so a later push can rerun its proof and resolve the thread. */
export type TrackedThread = {
  rootId: number;
  file: string;
  title: string;
  proof?: SavedProof;
  /** The head commit at which the proof passed, once it has. */
  fixedIn?: string;
};

export type WatchState = {
  version: 1;
  /** Comments already acted on or deliberately ignored. */
  handled: number[];
  /** The last head a review cycle started on, so a failed cycle is not retried on its own. */
  attemptedHead?: string;
  /** The last head whose review finished; the next push is reviewed from here. */
  reviewedHead?: string;
  threads: TrackedThread[];
};

export const COMMAND = "/auto-review";
const isOurs = (comment: Comment) => comment.body.includes(POSTED_MARKER);
const isCommand = (comment: Comment) => comment.body.trim().toLowerCase().startsWith(COMMAND);

export const REFUSAL =
  "Sorry, AutoReview can't act on this request: only people with write access to this repository can run it.";

/**
 * Starts watching from what the pull request already shows: existing comments are history, not requests,
 * and a head AutoReview already reviewed is not reviewed again.
 */
export function initialState(
  comments: Comment[],
  reviews: Array<{ body: string; commit_id: string }>,
): WatchState {
  const reviewed = reviews
    .filter((review) => review.body.includes(POSTED_MARKER))
    .at(-1)?.commit_id;
  return {
    version: 1,
    handled: comments.map((comment) => comment.id),
    ...(reviewed && { attemptedHead: reviewed, reviewedHead: reviewed }),
    threads: [],
  };
}

/** New comments from people, whose write access `decide` needs to know. */
export function pending(state: WatchState, comments: Comment[]) {
  const handled = new Set(state.handled);
  return comments.filter((comment) => !handled.has(comment.id) && !comment.bot && !isOurs(comment));
}

/**
 * Decides one polling pass. Only `trusted` people (the developer running AutoReview, and anyone with write
 * access) can start a review or get an answer; others get one refusal. A push is reviewed unprompted only
 * when the pull request's author is trusted, because proving a finding runs the pull request's code.
 */
export function decide(input: {
  state: WatchState;
  head: string;
  authorTrusted: boolean;
  conversation: Comment[];
  reviewComments: Comment[];
  trusted: ReadonlySet<string>;
}) {
  const roots = new Map(
    input.reviewComments
      .filter((comment) => !comment.inReplyTo)
      .map((comment) => [comment.id, comment]),
  );
  const commands = pending(input.state, input.conversation).filter(isCommand);
  const replies = pending(input.state, input.reviewComments).flatMap((reply) => {
    const root = reply.inReplyTo ? roots.get(reply.inReplyTo) : undefined;
    return root && isOurs(root) ? [{ reply, root }] : [];
  });
  const command = commands.filter((comment) => input.trusted.has(comment.login)).at(-1);
  const pushed = input.head !== input.state.attemptedHead && input.authorTrusted;
  return {
    review: command || pushed ? { command } : undefined,
    answer: replies.filter(({ reply }) => input.trusted.has(reply.login)),
    refuse: [
      ...commands
        .filter((comment) => !input.trusted.has(comment.login))
        .map((comment) => ({ comment, root: undefined as Comment | undefined })),
      ...replies
        .filter(({ reply }) => !input.trusted.has(reply.login))
        .map(({ reply, root }) => ({ comment: reply, root })),
    ],
    handled: [
      ...pending(input.state, input.conversation),
      ...pending(input.state, input.reviewComments),
    ].map((comment) => comment.id),
  };
}

/**
 * Drops new findings that repeat an open AutoReview thread: same file, within a few lines of where
 * GitHub now shows the thread. Outdated threads have no current line, so they never match.
 */
export function withoutOpenThreads<T extends Pick<Finding, "file" | "line">>(
  findings: T[],
  open: Comment[],
) {
  return findings.filter(
    (finding) =>
      !open.some(
        (thread) =>
          thread.path === finding.file &&
          thread.line != null &&
          Math.abs(thread.line - finding.line) <= 5,
      ),
  );
}

export const replySchema = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "resolve"],
  properties: { reply: { type: "string" }, resolve: { type: "boolean" } },
};

export function parseReply(value: unknown) {
  const output = value as { reply?: unknown; resolve?: unknown } | null;
  if (
    typeof output?.reply !== "string" ||
    !output.reply.trim() ||
    typeof output.resolve !== "boolean"
  )
    throw new Error("Invalid reply from the agent");
  return { reply: output.reply.trim(), resolve: output.resolve };
}

/** The task for answering a reply on one of AutoReview's threads, read-only, in a checkout of `head`. */
export function replyPrompt(thread: Comment[], head: string, proof?: SavedProof) {
  const [root, ...replies] = thread;
  const conversation = replies.map(
    (comment) =>
      `${isOurs(comment) ? "AutoReview" : `@${comment.login}`}:\n${comment.body.replace(POSTED_MARKER, "").trim()}`,
  );
  return `You are AutoReview. You posted the review comment below on a pull request, and people replied. You are in a read-only checkout of the pull request's current head (${head}). Read the code to check what the last reply says, then write AutoReview's next reply.

${proof ? `The finding was proven by a test: \`${proof.bugCommand}\` failed with \`${proof.expectedFailure}\` at the reviewed commit. You cannot run it now.\n\n` : ""}Your comment on ${root!.path}:
${root!.body.replace(POSTED_MARKER, "").trim()}

${conversation.join("\n\n")}

Rules:
- If the reply shows the finding is wrong, or that the behaviour is deliberate, agree plainly, say why in one sentence, and set resolve to true.
- If the reply says it is fixed, read the current code. If the fix holds, say so and set resolve to true. If it does not, say what still goes wrong, concretely.
- If the reply asks a question, answer it from the code and cite file:line.
- If the finding stands, say why in one or two sentences with the evidence.
- Keep it to a few sentences of plain language. No greeting, no apology, no praise. Do not claim you ran anything; you only read code.
- Otherwise set resolve to false.`;
}

export const fixedMessage = (head: string, proof: SavedProof) =>
  `Fixed in ${head.slice(0, 10)}: \`${proof.bugCommand}\` now passes.`;
