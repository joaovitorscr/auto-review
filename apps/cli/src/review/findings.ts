import { normalize } from "node:path";
import type { ReviewContext } from "./context.js";

const citationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["file", "revision", "startLine", "endLine"],
  properties: {
    file: { type: "string" },
    revision: { type: "string", enum: ["base", "head"] },
    startLine: { type: "integer", minimum: 1 },
    endLine: { type: "integer", minimum: 1 },
  },
};
const auditSchema = {
  type: "object",
  additionalProperties: false,
  required: ["observations", "conclusion", "counterChecks", "uncertainties"],
  properties: {
    observations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claim", "evidenceIndices"],
        properties: {
          claim: { type: "string" },
          evidenceIndices: { type: "array", items: { type: "integer", minimum: 1 } },
        },
      },
    },
    conclusion: { type: "string" },
    counterChecks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["check", "result", "summary"],
        properties: {
          check: { type: "string" },
          result: { type: "string", enum: ["supports_finding", "refutes_finding", "inconclusive"] },
          summary: { type: "string" },
        },
      },
    },
    uncertainties: { type: "array", items: { type: "string" } },
  },
};

// The survey comes first so the detector enumerates changed behaviours before it decides which to propose.
const surveySchema = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["file", "line", "behaviour", "risk"],
    properties: {
      file: { type: "string" },
      line: { type: "integer", minimum: 1 },
      behaviour: { type: "string" },
      risk: { type: "string" },
    },
  },
};
export const findingsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["survey", "findings"],
  properties: {
    survey: surveySchema,
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "title",
          "severity",
          "confidence",
          "file",
          "line",
          "explanation",
          "scenario",
          "suggestedFix",
          "evidence",
          "audit",
        ],
        properties: {
          title: { type: "string" },
          severity: { type: "string", enum: ["critical", "high", "medium"] },
          confidence: { type: "number" },
          file: { type: "string" },
          line: { type: "integer", minimum: 1 },
          explanation: { type: "string" },
          scenario: { type: "string" },
          suggestedFix: { type: "string" },
          evidence: { type: "array", items: citationSchema },
          audit: auditSchema,
        },
      },
    },
  },
};
export const validationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["decisions"],
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["candidateId", "verdict", "reason", "audit"],
        properties: {
          candidateId: { type: "integer", minimum: 1 },
          verdict: { type: "string", enum: ["accept", "reject", "needs_more_context"] },
          reason: { type: "string" },
          audit: auditSchema,
        },
      },
    },
  },
};

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a JSON object from the agent");
  return value as Record<string, unknown>;
}
const string = (value: unknown) => {
  if (typeof value !== "string" || !value.trim() || value.length > 12_000)
    throw new Error("Invalid or empty text in agent response");
  return value;
};
const integer = (value: unknown) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error(
      `Invalid line, evidence index or candidate ID in agent response: ${JSON.stringify(value)}`,
    );
  return value;
};
const array = (value: unknown, max = 30) => {
  if (!Array.isArray(value) || value.length > max)
    throw new Error(`Expected an array with at most ${max} entries from the agent`);
  return value as unknown[];
};
function parseAudit(value: unknown) {
  const audit = object(value);
  const observations = array(audit.observations).map((item) => {
    const observation = object(item);
    const evidenceIndices = array(observation.evidenceIndices).map(integer);
    if (!evidenceIndices.length) throw new Error("Audit observations need evidence references");
    return { claim: string(observation.claim), evidenceIndices };
  });
  const counterChecks = array(audit.counterChecks).map((item) => {
    const check = object(item);
    if (!["supports_finding", "refutes_finding", "inconclusive"].includes(String(check.result)))
      throw new Error("Invalid audit counter-check result");
    return {
      check: string(check.check),
      result: string(check.result),
      summary: string(check.summary),
    };
  });
  if (!observations.length || !counterChecks.length)
    throw new Error("Audit needs observations and counter-checks");
  return {
    observations,
    conclusion: string(audit.conclusion),
    counterChecks,
    uncertainties: array(audit.uncertainties).map(string),
  };
}

export function validateAuditReferences(
  audit: ReturnType<typeof parseAudit>,
  evidenceCount: number,
) {
  if (
    audit.observations.some((observation) =>
      observation.evidenceIndices.some((index) => index > evidenceCount),
    )
  )
    throw new Error("Audit references nonexistent evidence");
}

/** The detector's enumeration of changed behaviours; kept for evals, tolerant of agents that omit it. */
export function parseSurvey(value: unknown) {
  const survey = object(value).survey;
  if (survey === undefined) return [];
  // One entry per changed behaviour; a big part lists far more than the findings cap.
  return array(survey, 200).map((item) => {
    const entry = object(item);
    return { file: string(entry.file), line: integer(entry.line), behaviour: string(entry.behaviour), risk: string(entry.risk) };
  });
}

export function parseFindings(value: unknown) {
  return array(object(value).findings).map((item) => {
    const finding = object(item);
    const severity = finding.severity;
    if (severity !== "critical" && severity !== "high" && severity !== "medium")
      throw new Error("Invalid severity from the agent");
    if (
      typeof finding.confidence !== "number" ||
      !Number.isFinite(finding.confidence) ||
      finding.confidence < 0 ||
      finding.confidence > 1
    )
      throw new Error("Invalid confidence from the agent");
    const evidence = array(finding.evidence).map((item) => {
      const citation = object(item);
      const revision = citation.revision;
      if (revision !== "base" && revision !== "head")
        throw new Error("Invalid evidence revision from the agent");
      const startLine = integer(citation.startLine);
      const endLine = integer(citation.endLine);
      if (endLine < startLine) throw new Error("Invalid evidence range from the agent");
      return { file: string(citation.file), revision, startLine, endLine } as const;
    });
    const audit = parseAudit(finding.audit);
    validateAuditReferences(audit, evidence.length);
    return {
      audit,
      title: string(finding.title),
      severity,
      confidence: finding.confidence,
      file: string(finding.file),
      line: integer(finding.line),
      explanation: string(finding.explanation),
      scenario: string(finding.scenario),
      suggestedFix: string(finding.suggestedFix),
      evidence,
    } as const;
  });
}
export type Finding = ReturnType<typeof parseFindings>[number];

export function parseDecisions(value: unknown) {
  return array(object(value).decisions).map((item) => {
    const decision = object(item);
    const verdict = decision.verdict;
    if (verdict !== "accept" && verdict !== "reject" && verdict !== "needs_more_context")
      throw new Error("Invalid validation verdict from the agent");
    return {
      candidateId: integer(decision.candidateId),
      verdict,
      reason: string(decision.reason),
      audit: parseAudit(decision.audit),
    } as const;
  });
}

/** `retrieved` holds head ranges the agent read itself and that exist in the checkout. */
export function unsupportedReason(
  finding: Finding,
  context: ReviewContext,
  retrieved: ReadonlyArray<{ file: string; startLine: number; endLine: number }> = [],
) {
  if (
    !context.changes.some(
      (change) => change.file === finding.file && change.reviewLines.includes(finding.line),
    )
  )
    return "Finding is not anchored to a changed head line or a deletion anchor.";
  // Low enough that the counter-review, not the detector's self-rating, decides borderline candidates.
  if (finding.confidence < 0.5) return "Confidence is below 0.5.";
  if (!finding.evidence.length) return "Finding has no source evidence.";
  for (const citation of finding.evidence) {
    if (
      !context.snippets.some(
        (snippet) =>
          snippet.file === citation.file &&
          snippet.revision === citation.revision &&
          snippet.startLine <= citation.startLine &&
          snippet.endLine >= citation.endLine,
      ) &&
      !retrieved.some(
        (entry) =>
          entry.file === normalize(citation.file) &&
          citation.revision === "head" &&
          entry.startLine === citation.startLine &&
          entry.endLine === citation.endLine,
      )
    )
      return "Evidence is outside the supplied source ranges and the head checkout.";
  }
  return undefined;
}
