import { describe, expect, it } from "vitest";
import { POSTED_MARKER, reviewPayload } from "./post.js";

const proven = { verdict: "proven", testPatch: "+it('fails')", test: { files: [], bugCommand: "vitest a", expectedFailure: "expected 3" } };
const finding = (severity: string, line: number, verification: object | undefined = proven) => ({
  severity,
  confidence: 0.9,
  file: "src/amount.ts",
  line,
  title: `${severity} bug`,
  explanation: "Explanation.",
  scenario: "Scenario.",
  suggestedFix: "Fix.",
  evidence: [],
  verification,
});
const report = (overrides: object = {}) =>
  ({
    status: "complete",
    head: "abc123",
    workingTreeSnapshot: false,
    findings: [finding("critical", 2), finding("high", 4), finding("medium", 9)],
    ...overrides,
  }) as unknown as Parameters<typeof reviewPayload>[0];

describe("reviewPayload", () => {
  it("posts findings at or above the minimum on the reviewed commit", () => {
    const payload = reviewPayload(report(), "high")!;
    expect(payload.commit_id).toBe("abc123");
    expect(payload.comments.map((comment) => comment.line)).toEqual([2, 4]);
    expect(payload.comments[0]).toMatchObject({ path: "src/amount.ts", side: "RIGHT" });
    expect(payload.comments[0]!.body.startsWith("🔴 **Critical** `src/amount.ts:2`\n\n**critical bug**")).toBe(true);
    expect(payload.comments[1]!.body.startsWith("🟠 **High** `src/amount.ts:4`")).toBe(true);
    expect(payload.comments[0]!.body).toContain(POSTED_MARKER);
    expect(reviewPayload(report(), "medium")!.comments).toHaveLength(3);
  });

  it("posts only proven findings, with the test that proves them", () => {
    const findings = [finding("high", 1), finding("high", 2, { verdict: "refuted" }), finding("high", 3, { verdict: "untested" })];
    const payload = reviewPayload(report({ findings }), "high")!;
    expect(payload.comments.map((comment) => comment.line)).toEqual([1]);
    expect(payload.comments[0]!.body).toContain("`vitest a` fails at this commit");
    expect(payload.comments[0]!.body).toContain("it('fails')");
    expect(reviewPayload(report({ findings: [{ ...finding("high", 1), verification: undefined }] }), "high")).toBeUndefined();
  });

  it("folds the test and a prompt for the developer's agent, which is done when the test passes", () => {
    const body = reviewPayload(report(), "high")!.comments[0]!.body;
    expect(body).toContain("<summary>🧪 Failing test</summary>");
    expect(body).toContain("<summary>🤖 Prompt for your coding agent</summary>");
    expect(body).toContain("In file @src/amount.ts around line 2:");
    expect(body).toContain("Done when `vitest a` passes; it fails now with `expected 3`.");
  });

  it("treats a proof that forced its conditions as low", () => {
    const findings = [finding("high", 1, { ...proven, forced: "A one-second time limit." })];
    expect(reviewPayload(report({ findings }), "medium")).toBeUndefined();
  });

  it("returns nothing when no finding qualifies", () => {
    expect(reviewPayload(report({ findings: [finding("medium", 9)] }), "high")).toBeUndefined();
  });

  it("refuses failed reports and working-tree snapshots", () => {
    expect(() => reviewPayload(report({ status: "failed" }), "high")).toThrow("finished review");
    expect(() => reviewPayload(report({ workingTreeSnapshot: true }), "high")).toThrow("uncommitted work");
  });
});
