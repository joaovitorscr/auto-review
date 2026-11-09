import type { review } from "./run.js";
import type { Verification } from "./verify.js";

type Report = Awaited<ReturnType<typeof review>>;
type VerifiedFinding = Report["findings"][number] & { verification?: Verification };

export const rank = { critical: 0, high: 1, medium: 2, low: 3 };
const label = { critical: "🔴 **Critical**", high: "🟠 **High**", medium: "🟡 **Medium**", low: "🟢 **Low**" };

// A proof that needed conditions real users do not meet makes the finding low, whatever the reviewer said.
const severity = (finding: VerifiedFinding) => (finding.verification?.forced ? "low" : finding.severity);

// Marks comments AutoReview posted, so a later pass can find them among the developer's own comments.
export const POSTED_MARKER = "<!-- auto-review -->";

/** Ends a conversation reply AutoReview posts under the developer's account, so readers know who wrote it. */
export const signed = (body: string) => `${body}\n\n<sub>🤖 AutoReview</sub>\n${POSTED_MARKER}`;

// GitHub rejects comments over 65,536 characters, so a very long test is named rather than quoted.
function testSection({ test, testPatch }: Verification) {
  if (!test) return "";
  const proof = `\`${test.bugCommand}\` fails at this commit with \`${test.expectedFailure}\` and passes with a minimal fix.`;
  const patch = testPatch && testPatch.length <= 50_000 ? `\n\n\`\`\`\`\`diff\n${testPatch}\n\`\`\`\`\`` : "";
  return `<details>\n<summary>🧪 Failing test</summary>\n\n${proof}${patch}\n\n</details>`;
}

// The same finding as a task for the developer's coding agent, with the test as its definition of done.
function promptSection(finding: VerifiedFinding) {
  const test = finding.verification?.test;
  const done = test ? `\n\nDone when \`${test.bugCommand}\` passes; it fails now with \`${test.expectedFailure}\`. The failing test is in this comment.` : "";
  return `<details>\n<summary>🤖 Prompt for your coding agent</summary>\n\n\`\`\`\`text\nIn file @${finding.file} around line ${finding.line}:\n\n${finding.title}. ${finding.explanation}\n\nScenario: ${finding.scenario}\n\nSuggested fix: ${finding.suggestedFix}${done}\n\`\`\`\`\n\n</details>`;
}

/** One inline comment in AutoReview's format: severity and location, the problem, the fix, then the proof. */
export function findingComment(finding: VerifiedFinding) {
  return [
    `${label[severity(finding)]} \`${finding.file}:${finding.line}\``,
    `**${finding.title}**`,
    finding.explanation,
    `**Scenario:** ${finding.scenario}`,
    `**Suggested fix:** ${finding.suggestedFix}`,
    finding.verification?.verdict === "untested"
      ? `> ⚠️ **Not proven by a test.** ${finding.verification.reason}`
      : finding.verification
        ? testSection(finding.verification)
        : "",
    promptSection(finding),
  ]
    .filter(Boolean)
    .join("\n\n") + `\n${POSTED_MARKER}`;
}

export type Minimum = "high" | "medium" | "low";
export const isMinimum = (value: unknown): value is Minimum => value === "high" || value === "medium" || value === "low";
/** True when `finding` is at `minimum` severity or above, after a forced proof has made it low. */
export const atLeast = (finding: VerifiedFinding, minimum: Minimum) => rank[severity(finding)] <= rank[minimum];

/**
 * Builds the body for `POST /repos/{owner}/{repo}/pulls/{number}/reviews` from a verified review report.
 * Every finding at or above `minimum` gets an inline comment, proven ones with their failing test and
 * untested ones marked as not proven, except findings a test refuted or the project states as deliberate.
 * The review body always says what was reviewed and counts each outcome, so a clean review is visible too.
 * `posted` lists the commented findings in comment order.
 */
export function reviewPayload(report: Omit<Report, "findings"> & { findings: VerifiedFinding[] }, minimum: Minimum) {
  if (report.status !== "complete" && report.status !== "partial")
    throw new Error(`Only a finished review can be posted; this report is ${String(report.status)}.`);
  if (report.workingTreeSnapshot)
    throw new Error("This report reviewed uncommitted work. Push it and review the pull request head with --head.");
  const considered = report.findings.filter((finding) => atLeast(finding, minimum));
  const unverified = considered.filter((finding) => !finding.verification).length;
  if (unverified) throw new Error(`${unverified} finding(s) at ${minimum} severity or above are not verified yet. Run verify on this report first.`);
  const count = (verdict: Verification["verdict"]) => considered.filter((finding) => finding.verification!.verdict === verdict).length;
  const posted = considered
    .filter((finding) => finding.verification!.verdict === "proven" || finding.verification!.verdict === "untested")
    .sort((left, right) => rank[severity(left)] - rank[severity(right)]);
  const reviewed = `Reviewed \`${report.head.slice(0, 10)}\``;
  const lines = posted.length
    ? [`${reviewed}: ${posted.length} finding(s), ${count("proven")} proven by a test and ${count("untested")} not proven.`]
    : [`${reviewed}: no findings.`];
  const withheld = [count("refuted") && `${count("refuted")} refuted by its test`, count("intended") && `${count("intended")} deliberate according to the project`].filter(Boolean);
  if (withheld.length) lines.push(`Not posted: ${withheld.join(" and ")}.`);
  return {
    commit_id: report.head,
    event: "COMMENT" as const,
    body: `${lines.join(" ")}\n\n<sub>🤖 AutoReview</sub>\n${POSTED_MARKER}`,
    comments: posted.map((finding) => ({ path: finding.file, line: finding.line, side: "RIGHT" as const, body: findingComment(finding) })),
    posted,
  };
}
