import type { review } from "./run.js";

type Report = Awaited<ReturnType<typeof review>>;

const rank = { critical: 0, high: 1, medium: 2, low: 3 };

// Marks comments AutoReview posted, so a later pass can find them among the developer's own comments.
export const POSTED_MARKER = "<!-- auto-review -->";

/**
 * Builds the body for `POST /repos/{owner}/{repo}/pulls/{number}/reviews` from a saved review report:
 * one inline comment per finding at or above `minimum`. Returns undefined when nothing qualifies.
 */
export function reviewPayload(report: Report, minimum: "high" | "medium") {
  if (report.status !== "complete" && report.status !== "partial")
    throw new Error(`Only a finished review can be posted; this report is ${String(report.status)}.`);
  if (report.workingTreeSnapshot)
    throw new Error("This report reviewed uncommitted work. Push it and review the pull request head with --head.");
  const posted = report.findings.filter((finding) => rank[finding.severity] <= rank[minimum]);
  if (!posted.length) return undefined;
  return {
    commit_id: report.head,
    event: "COMMENT" as const,
    body: `AutoReview: ${posted.length} finding(s) at ${minimum} severity or above.\n\n${POSTED_MARKER}`,
    comments: posted.map((finding) => ({
      path: finding.file,
      line: finding.line,
      side: "RIGHT" as const,
      body: [
        `**${finding.severity}: ${finding.title}**`,
        finding.explanation,
        `**Scenario:** ${finding.scenario}`,
        `**Suggested fix:** ${finding.suggestedFix}`,
        POSTED_MARKER,
      ].join("\n\n"),
    })),
  };
}
