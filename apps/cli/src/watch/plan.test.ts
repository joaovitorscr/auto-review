import { describe, expect, it } from "vitest";
import { POSTED_MARKER } from "../review/post.js";
import { decide, initialState, withoutOpenThreads } from "./plan.js";
import type { Comment, WatchState } from "./plan.js";

const finding: Comment = {
  id: 1,
  login: "dev",
  bot: false,
  body: `🟠 **High** finding\n${POSTED_MARKER}`,
  path: "src/a.ts",
  line: 10,
};
const say = (id: number, login: string, body: string, extra: Partial<Comment> = {}): Comment => ({
  id,
  login,
  bot: false,
  body,
  ...extra,
});
const state = (overrides: Partial<WatchState> = {}): WatchState => ({
  version: 1,
  handled: [1],
  attemptedHead: "head1",
  reviewedHead: "head1",
  threads: [],
  ...overrides,
});
const run = (input: Partial<Parameters<typeof decide>[0]>) =>
  decide({
    state: state(),
    head: "head1",
    authorTrusted: true,
    conversation: [],
    reviewComments: [finding],
    trusted: new Set(["dev", "maintainer"]),
    ...input,
  });

describe("decide", () => {
  it("reviews a new push only when the pull request's author is trusted", () => {
    expect(run({ head: "head2" }).review).toEqual({ command: undefined });
    expect(run({ head: "head2", authorTrusted: false }).review).toBeUndefined();
    expect(run({}).review).toBeUndefined();
  });

  it("does not retry a head whose review already started", () => {
    expect(run({ head: "head2", state: state({ attemptedHead: "head2" }) }).review).toBeUndefined();
  });

  it("runs /auto-review for trusted people and refuses everyone else", () => {
    const conversation = [
      say(5, "stranger", "/auto-review"),
      say(6, "maintainer", "/auto-review please"),
      say(7, "stranger", "nice work"),
    ];
    const plan = run({ conversation, authorTrusted: false });
    expect(plan.review?.command?.id).toBe(6);
    expect(plan.refuse.map(({ comment }) => comment.id)).toEqual([5]);
    expect(plan.handled).toEqual([5, 6, 7]);
  });

  it("answers trusted replies on AutoReview's threads and refuses the rest", () => {
    const reviewComments = [
      finding,
      say(2, "maintainer", "This is intended.", { inReplyTo: 1 }),
      say(3, "stranger", "Can you check again?", { inReplyTo: 1 }),
      say(4, "maintainer", "Unrelated thread", { inReplyTo: 99 }),
    ];
    const plan = run({ reviewComments });
    expect(plan.answer.map(({ reply }) => reply.id)).toEqual([2]);
    expect(plan.refuse.map(({ comment, root }) => [comment.id, root?.id])).toEqual([[3, 1]]);
    expect(plan.handled).toEqual([2, 3, 4]);
  });

  it("never answers itself, bots, or comments already handled", () => {
    const reviewComments = [
      finding,
      say(2, "dev", `Fixed in abc.\n${POSTED_MARKER}`, { inReplyTo: 1 }),
      say(3, "macroscopeapp[bot]", "Looks fixed.", { inReplyTo: 1, bot: true }),
      say(4, "dev", "Already answered.", { inReplyTo: 1 }),
    ];
    const plan = run({
      reviewComments,
      state: state({ handled: [1, 4] }),
      conversation: [say(8, "dev", `/auto-review\n${POSTED_MARKER}`)],
    });
    expect(plan).toMatchObject({ review: undefined, answer: [], refuse: [], handled: [] });
  });
});

describe("initialState", () => {
  it("treats existing comments as history and skips a head AutoReview already reviewed", () => {
    const reviews = [
      { body: `AutoReview\n${POSTED_MARKER}`, commit_id: "old" },
      { body: "LGTM", commit_id: "new" },
    ];
    expect(initialState([finding, say(2, "dev", "/auto-review")], reviews)).toEqual({
      version: 1,
      handled: [1, 2],
      attemptedHead: "old",
      reviewedHead: "old",
      threads: [],
    });
    expect(initialState([], [])).toEqual({ version: 1, handled: [], threads: [] });
  });
});

describe("withoutOpenThreads", () => {
  it("drops findings near an open thread in the same file, but not near outdated ones", () => {
    const findings = [
      { file: "src/a.ts", line: 13 },
      { file: "src/a.ts", line: 30 },
      { file: "src/b.ts", line: 10 },
    ];
    expect(withoutOpenThreads(findings, [finding])).toEqual(findings.slice(1));
    expect(withoutOpenThreads(findings, [{ ...finding, line: null }])).toEqual(findings);
  });
});
