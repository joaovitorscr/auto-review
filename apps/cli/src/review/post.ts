import type { review } from "./run.js";
import type { Verification } from "./verify.js";

type Report = Awaited<ReturnType<typeof review>>;
type VerifiedFinding = Report["findings"][number] & { verification?: Verification };

const rank = { critical: 0, high: 1, medium: 2, low: 3 };

// Marks comments AutoReview posted, so a later pass can find them among the developer's own comments.
export const POSTED_MARKER = "<!-- auto-review -->";

// GitHub rejects comments over 65,536 characters, so a very long test is named rather than quoted.
function testSection({ test, testPatch }: Verification) {
  if (!test) return "";
  const heading = `**Proof:** \`${test.bugCommand}\` fails at this commit with \`${test.expectedFailure}\` and passes with a minimal fix. A fix is done when it passes.`;
  if (!testPatch || testPatch.length > 50_000) return heading;
  return `${heading}\n\n<details><summary>Failing test</summary>\n\n\`\`\`\`\`diff\n${testPatch}\n\`\`\`\`\`\n\n</details>`;
}

/**
 * Builds the body for `POST /repos/{owner}/{repo}/pulls/{number}/reviews` from a saved review report:
 * one inline comment per proven finding at or above `minimum`, carrying its failing test for the fix
 * agent. Returns undefined when nothing qualifies.
 */
export function reviewPayload(report: Omit<Report, "findings"> & { findings: VerifiedFinding[] }, minimum: "high" | "medium") {
  if (report.status !== "complete" && report.status !== "partial")
    throw new Error(`Only a finished review can be posted; this report is ${String(report.status)}.`);
  if (report.workingTreeSnapshot)
    throw new Error("This report reviewed uncommitted work. Push it and review the pull request head with --head.");
  const posted = report.findings.filter((finding) => finding.verification?.verdict === "proven" && rank[finding.severity] <= rank[minimum]);
  if (!posted.length) return undefined;
  return {
    commit_id: report.head,
    event: "COMMENT" as const,
    body: `AutoReview: ${posted.length} proven finding(s) at ${minimum} severity or above.\n\n${POSTED_MARKER}`,
    comments: posted.map((finding) => ({
      path: finding.file,
      line: finding.line,
      side: "RIGHT" as const,
      body: [
        `**${finding.severity}: ${finding.title}**`,
        finding.explanation,
        `**Scenario:** ${finding.scenario}`,
        `**Suggested fix:** ${finding.suggestedFix}`,
        testSection(finding.verification!),
        POSTED_MARKER,
      ].join("\n\n"),
    })),
  };
}
