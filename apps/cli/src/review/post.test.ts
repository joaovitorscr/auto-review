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
    const payload = reviewPayload(report(), "high");
    expect(payload.commit_id).toBe("abc123");
    expect(payload.comments.map((comment) => comment.line)).toEqual([2, 4]);
    expect(payload.comments[0]).toMatchObject({ path: "src/amount.ts", side: "RIGHT" });
    expect(payload.comments[0]!.body.startsWith("🔴 **Critical** `src/amount.ts:2`\n\n**critical bug**")).toBe(true);
    expect(payload.comments[1]!.body.startsWith("🟠 **High** `src/amount.ts:4`")).toBe(true);
    expect(payload.comments[0]!.body).toContain(POSTED_MARKER);
    expect(reviewPayload(report(), "medium").comments).toHaveLength(3);
  });

  it("posts proven findings with their test and untested ones as not proven, but never refuted or deliberate ones", () => {
    const findings = [
      finding("high", 1),
      finding("high", 2, { verdict: "refuted", reason: "It adds." }),
      finding("medium", 3, { verdict: "untested", reason: "No test runner." }),
      finding("low", 4, { verdict: "intended", reason: "README says so." }),
    ];
    const payload = reviewPayload(report({ findings }), "low");
    expect(payload.comments.map((comment) => comment.line)).toEqual([1, 3]);
    expect(payload.comments[0]!.body).toContain("`vitest a` fails at this commit");
    expect(payload.comments[0]!.body).toContain("it('fails')");
    expect(payload.comments[1]!.body).toContain("> ⚠️ **Not proven by a test.** No test runner.");
    expect(payload.body).toContain("Reviewed `abc123`: 2 finding(s), 1 proven by a test and 1 not proven.");
    expect(payload.body).toContain("Not posted: 1 refuted by its test and 1 deliberate according to the project.");
  });

  it("treats a proof that forced its conditions as low", () => {
    const findings = [finding("high", 1, { ...proven, forced: "A one-second time limit." })];
    expect(reviewPayload(report({ findings }), "medium").comments).toEqual([]);
    expect(reviewPayload(report({ findings }), "low").comments[0]!.body).toContain("🟢 **Low**");
  });

  it("posts a clean review so the pull request shows it ran", () => {
    const payload = reviewPayload(report({ findings: [finding("medium", 9)] }), "high");
    expect(payload).toMatchObject({ commit_id: "abc123", comments: [] });
    expect(payload.body).toContain("Reviewed `abc123`: no findings.");
    expect(payload.body).toContain(POSTED_MARKER);
  });

  it("refuses a report whose findings were never verified", () => {
    const findings = [{ ...finding("high", 1), verification: undefined }];
    expect(() => reviewPayload(report({ findings }), "low")).toThrow("Run verify on this report first");
  });

  it("refuses failed reports and working-tree snapshots", () => {
    expect(() => reviewPayload(report({ status: "failed" }), "high")).toThrow("finished review");
    expect(() => reviewPayload(report({ workingTreeSnapshot: true }), "high")).toThrow("uncommitted work");
  });
});
