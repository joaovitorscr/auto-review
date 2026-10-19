# AutoReview proposal

Status: proposal for discussion, not an implementation record.
Updated: October 1, 2026 (after stage 1).

## Product direction

AutoReview is an open-source code reviewer that runs locally and uses the developer's installed coding agent. Its purpose is to find actionable regressions by understanding how a change interacts with the surrounding codebase.

The inspiration is a Macroscope alternative with user-controlled execution and model choice. The first release should earn trust through useful findings, clear evidence, and low noise. Feature parity with another product is not a release requirement.

The agreed delivery order is a local CLI first, followed by a local web dashboard. Initial agent support targets Codex and Claude Code, using their existing authentication and configuration. AutoReview should not require a hosted AutoReview account.

Running AutoReview locally does not imply that inference stays on the machine. The selected coding agent determines where model requests go. Fully local inference and direct model API integrations are deferred.

## Current state

As of commit `07f51a1` on `main` (October 1, 2026), the prototype is committed. Stage 1 is complete: the AST index, immutable review snapshots in temporary Git worktrees, context selection, the Codex adapter with detector and counter-review passes, citation checks, Markdown output, and JSON reports are in `apps/cli`. The project is MIT licensed, and the README matches the code. A fresh clone installs with `vp install` and runs the documented dry run.

Stage 2 work (uncommitted): relative paths resolve from the invoking directory, reports carry a `complete`/`partial`/`failed`/`cancelled` status, and Ctrl-C stops Codex and removes the worktree. On a two-file fixture, a dropped cents conversion produced one accepted high finding and a safe `toCents` extraction produced none. Context budget raised from 120,000 to 400,000 characters after a 15-file range packed only 12 snippets and omitted 1797 ranges, including changed code; the same range now packs 64 snippets with none omitted. Docs, lockfiles, images, and ignore files are listed as `ignored` and no longer make a review `partial`; other unsupported files (CSS, package.json) still do. Syntax diagnostics only count for reviewed files. A live review of this repository's own stage 1 range (26s detector, 21s validator) accepted one plausible medium finding: indexing a fresh worktree cannot resolve a tsconfig that extends an npm package, which aborted the whole review. Fixed: config packages resolve from the original checkout's `node_modules`, and unresolvable configs fall back to default options and mark the review `partial`.

Stage 3 work (uncommitted): `--agent claude` runs Claude Code through the same contract, now in `review/agent.ts`. On the cents fixture it accepted one critical finding for the bug (two passes, about 18s and $0.17) and returned no findings for the refactor (one pass, $0.02).

Stage 4 started (uncommitted): `evals/` has 7 labeled synthetic cases with `pnpm eval`; both agents found every regression with no false alarms. See `evaluation.md`. Real regressions from the owner's repositories are still needed.

The dashboard still displays PR snapshots, not review runs. Planning documents live in `docs/internals/`. Review quality has not been measured.

## Goals

1. Produce findings that identify a concrete regression, its trigger, its impact, and the code evidence supporting it.
2. Review beyond the diff when unchanged callers, tests, configuration, or state transitions determine behavior.
3. Let users choose an installed coding agent without changing review behavior or the report format.
4. Preserve the user's checkout and keep review artifacts under local user control.
5. Make incomplete coverage, failed runs, and uncertainty visible.
6. Measure review quality before increasing orchestration complexity.
7. Make installation and the first review practical for an outside contributor.

## First usable experience

From a local Git repository, the user selects a base revision and an agent:

```sh
# Proposed commands; these are not the current CLI contract.
auto-review review --base main --agent codex
auto-review review --base main --agent claude
```

AutoReview resolves the revisions, creates an immutable source snapshot, gathers initial context, and asks the selected agent to investigate the change. A separate review pass challenges candidate findings before they appear in the final report.

The terminal shows truthful progress and a concise result. A saved JSON report records the revisions, findings, evidence, coverage limits, agent metadata, and available usage information. The command can be cancelled without modifying the user's source files.

A successful review with no supported findings, a partially covered review, and a failed review must remain distinguishable. No findings is not a claim that the change is bug-free.

## Initial scope

- Committed branch changes compared with their merge base against an explicit base revision.
- JavaScript and TypeScript as the first supported languages.
- Codex first, followed by Claude Code through the same adapter contract.
- One detector pass and one fresh counter-review pass, with validation skipped when there are no eligible candidates.
- Read-only repository investigation and evidence-backed findings.
- Markdown terminal output and versioned JSON reports.
- Explicit coverage reporting for unsupported files, missing context, and budget limits.

Staged, unstaged, and untracked changes are excluded from the first review mode and must be called out in the CLI. Reviewing working-tree changes can follow once snapshot semantics are defined.

## Review design

The proposed flow is:

```text
Git revisions
    -> immutable snapshot and diff
    -> initial repository context
    -> agent investigation and candidate findings
    -> local evidence checks
    -> counter-review
    -> final findings and saved report
```

AutoReview owns revision selection, review policy, finding validation, coverage reporting, and artifact formats. Agent adapters own process invocation, agent-specific configuration, structured output handling, errors, timeouts, and cancellation.

Keep the shared contract small. Add capability differences only when an actual adapter needs them. Agent and model are separate concepts: users select an agent integration and may override its model where supported. Record resolved model and usage only when the agent exposes them; unknown values should remain unknown.

The current provider contract lives inside the Codex adapter. Move it into agent-neutral code when adding the second adapter. Extract a shared review package when the CLI and dashboard service both need it, rather than reorganizing the entire repository in advance.

### Context and investigation

Retain the AST index as an initial context aid. It can identify callers and dependencies cheaply, but it is not a complete model of runtime behavior.

The current prototype supplies a fixed context pack. The proposed next step is bounded, read-only investigation so agents can resolve questions by reading source and searching the immutable checkout. Evidence validation must then include those additional retrieved sources, rather than accepting arbitrary citations or restricting findings to the initial pack forever.

Set explicit investigation and execution limits. The initial mode should not install dependencies, run project code, edit files, or publish comments. Agent-specific enforcement needs verification during adapter implementation.

Measure whether AST-selected context improves findings over a simpler diff-plus-search approach. If indexing fails, provide a clearly labeled fallback or an explicit incomplete result. A configuration-resolution failure should not silently become a clean review.

### Findings and counter-review

A finding should contain an actionable source location, concise title, severity, triggering scenario, explanation of impact, and supporting source references. Suggested fixes should stay brief and optional where the correct solution requires a product decision.

The counter-reviewer checks whether the issue was introduced by the change, whether the scenario is reachable, and whether existing guards invalidate it. Its outcomes are accept, reject, or insufficient context. Only supported findings belong in the main report.

Preserve short decision explanations for inspection. Do not require verbose reasoning transcripts. Model-reported confidence is not a calibrated probability and should not become the primary quality measure.

Handle deleted code and base-side evidence explicitly. Reports should not invent a surviving head line merely to satisfy a location rule. GitHub-specific anchoring can be applied later by the publishing adapter.

## Implementation stages

### 1. Consolidate the existing prototype

Inventory and preserve the current working changes. Keep the useful Git, review, indexing, and test code; remove obsolete experiments only after identifying them. Reconcile README claims and internal documentation with actual behavior. Replace the blanket `docs/` ignore with intentional rules so durable documentation can be tracked.

Choose an open-source license with the project owner before distribution. Document prerequisites and a reproducible first-run path.

Completion evidence: a fresh checkout can install dependencies and run the documented context dry run, and the documented feature set matches the code.

### 2. Complete the Codex CLI path

Make repository targeting work naturally from the invoking directory. Stabilize revision handling, reports, errors, cancellation, and cleanup. Keep the existing snapshot command separate from local review behavior.

Completion evidence: a known regression produces a supported finding, a safe refactor produces no findings, and failed or cancelled runs preserve the caller's checkout and report their status accurately.

### 3. Add Claude Code

Implement a second agent adapter using the same review policy and report contract. Verify the installed agent's supported execution, permission, and structured-output mechanisms before choosing flags or integration details.

Completion evidence: the same fixture inputs can run through either adapter without agent-specific branches in review orchestration. Adapter failures and malformed output produce explicit failures.

### 4. Establish a review-quality baseline

Start a small labeled corpus alongside the initial Codex work and run both agents once available. Include real regressions, safe refactors, pre-existing bugs, and cases where unchanged code disproves a plausible finding. Keep some cases separate from prompt development.

Record correct and incorrect findings, missed known bugs, duplicate comments, runtime, and available usage. Human inspection determines whether a finding is valid; another model should not be the sole judge.

Completion evidence: a repeatable comparison report and an agreed quality baseline. Choose release thresholds after collecting initial results, rather than inventing accuracy claims now.

### 5. Improve investigation from observed misses

Add bounded search and source reading, relevant test/configuration retrieval, and better handling of missing AST information. Prioritize changes that address failures in the corpus or real reviews.

Completion evidence: targeted cases improve without an unacceptable increase in false positives, runtime, or cost. Additional detectors or validators require the same justification.

### 6. Build the local dashboard

Use the same review engine behind a small local service. Start with file-based run persistence. Add repository and revision selection, agent selection, progress, cancellation, and review history.

Make findings beside the diff the central view. Let users inspect evidence and mark a finding useful or incorrect. Keep the existing PR timeline secondary. Follow the repository's shadcn/Base UI component requirements when implementing the interface.

Completion evidence: a user can launch, inspect, and revisit a review without manually moving report files. Displayed results remain tied to their exact reviewed revisions.

### 7. Add GitHub integration

Resolve PRs into the same local review inputs, then add deliberate publishing and CI execution. Associate comments with the reviewed revision and avoid duplicates on reruns.

Completion evidence: local and PR-triggered reviews share the same engine, and publication accurately represents the reviewed commit and coverage.

## Ideas to test, not commitments

- Compare fixed context packs with agent-led investigation.
- Compare AST-assisted retrieval with plain source search.
- Allow a different agent or model for counter-review if measured results justify the extra configuration.
- Use user feedback to grow the labeled corpus, without automatic prompt tuning.
- Add working-tree review for feedback before a commit.
- Add incremental review for new commits while invalidating findings whose evidence changed.
- Extend language support through generic source investigation before building more language-specific indexes.

## Deferred work

Automatic fixes and approvals, hosted accounts, automatic GitHub posting, direct provider APIs, fully local inference setup, vector databases, a complete repository graph, parallel specialist-agent teams, and multiple review modes are outside the first milestone.

These can be reconsidered when a concrete user need or measured failure makes them necessary.

## Next milestone

Complete the Codex CLI path (stage 2) on `main`. Use it on a real branch, inspect every emitted finding, and capture what it missed. That result should guide the next changes before dashboard work begins.

This proposal lives in `docs/internals/` with the other planning documents. Update this file when stages land; do not keep a second implementation checklist.
