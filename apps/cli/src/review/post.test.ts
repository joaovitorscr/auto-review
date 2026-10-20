import { describe, expect, it } from "vitest";
import { POSTED_MARKER, reviewPayload } from "./post.js";

const finding = (severity: string, line: number) => ({
  severity,
  confidence: 0.9,
  file: "src/amount.ts",
  line,
  title: `${severity} bug`,
  explanation: "Explanation.",
  scenario: "Scenario.",
  suggestedFix: "Fix.",
  evidence: [],
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
    expect(payload.comments[0]!.body).toContain("**critical: critical bug**");
    expect(payload.comments[0]!.body).toContain(POSTED_MARKER);
    expect(reviewPayload(report(), "medium")!.comments).toHaveLength(3);
  });

  it("returns nothing when no finding qualifies", () => {
    expect(reviewPayload(report({ findings: [finding("medium", 9)] }), "high")).toBeUndefined();
  });

  it("refuses failed reports and working-tree snapshots", () => {
    expect(() => reviewPayload(report({ status: "failed" }), "high")).toThrow("finished review");
    expect(() => reviewPayload(report({ workingTreeSnapshot: true }), "high")).toThrow("uncommitted work");
  });
});
