# Evaluating the reviewer

## Current corpus and runner

`evals/<case>/` holds `case.json` (split, expected kind, and for regressions the file and line range of the bug), `base/` files, and `head/` files that overwrite base in a second commit. `pnpm eval [--agent codex|claude]... [--split dev|holdout|all] [--case name]` builds each case as a temporary repository, reviews `HEAD~1..HEAD` with each agent (default both, dev split), prints a table, and saves full findings to `outputs/eval-<timestamp>.json`.

Outcomes are location matches only (`found`, `missed`, `clean`, `false alarm?`, `error`). A human confirms each finding; the runner never decides that a finding is correct. Tune prompts against `dev` only and run `holdout` for comparisons.

Baseline, October 1, 2026 (7 synthetic cases: 3 regressions, 2 safe refactors, 1 pre-existing bug, 1 guard in an unchanged caller):

- Claude Code (claude-opus-5-5): 3/3 regressions found at the labeled lines, 4/4 no-bug cases clean, no extra findings. About 3-5s and $0.04 for clean cases, 18s and $0.11-0.12 when a candidate goes through counter-review.
- Codex (configured default model): 3/3 found and 4/4 clean in the first full run, about 7s clean and 35s with counter-review. A second run hit the Codex usage limit.
- Before `minimum: 1` was added to integer schema fields, Claude returned a zero evidence index in 2 of 3 `removed-await` runs, which failed the review.

Every run is also recorded in `evals/progress.db` (SQLite, committed): `runs` (case, commit, `--note` config label, passes, cost, replay source), `findings` (every candidate, posted or not), `reference_hits` (the 15-line proximity match per reference comment) and `labels` (a human verdict per finding: `correct`, `incorrect`, `not_introduced`, `low_value`, `duplicate`, and which reference comment it is). Labels key on case, file, line and title, so a replay inherits them. `pnpm progress -- runs [case] | show <run> | compare <run> <run> | label <finding> <verdict> [--ref file:line] | import`. `compare` marks each reference comment ✓ (a labeled finding is that bug), ~ (only near) or ·, and reports posted volume, labeled precision and cost. Proximity is not correctness: only ✓ and labeled precision count as progress. For a readable `git diff` of the database, run once per clone: `git config diff.sqlite.textconv "sh -c 'sqlite3 -batch \"\$0\" .dump'"`.

Real material is collected in the git-ignored `corpus/` (`projects/`, `errors/`) before becoming cases. The synthetic cases are too easy to separate the agents. The next cases should be real regressions from the owner's repositories. Thresholds are not chosen yet.

## Original plan

The main risk is building an agent that sounds insightful while drifting toward the wrong kind of review. We need to measure whether it finds the right behavioral failures, whether it can justify them, and whether it knows when to stay quiet.

## Treat every finding as a claim

Do not evaluate only the final Markdown comment. Save the internal decision record:

```json
{
  "pr": "fixture-014",
  "question": "What happens after switching workspaces while this form is dirty?",
  "scenario": ["type in A", "switch to B", "submit"],
  "claims": [
    { "text": "the component keeps its local state", "evidence": ["ui.tsx:44-61"] },
    { "text": "submit uses the new workspace", "evidence": ["api.ts:8-19"] }
  ],
  "finding": { "severity": "medium", "file": "ui.tsx", "line": 57 },
  "validation": "accept",
  "published": true
}
```

This lets us see whether a correct comment came from a correct trace or from a lucky guess. It also makes model and prompt changes comparable.

## Build four kinds of fixtures

### Known positives

Use real bugs from personal repositories, open-source projects, and later production incidents. Each fixture should contain the introducing PR, the parent revision, the bug explanation, affected scenario, severity, and the smallest known fix.

Start with a handful of interaction bugs:

- local state survives a tenant or workspace switch;
- a stale request response overwrites a newer selection;
- a cache key omits an ownership identifier;
- a write path lacks a scope check that the read path has;
- a feature flag exposes a UI path that calls an incompatible API;
- a bulk selection survives a filter or pagination change;
- retrying a mutation creates duplicate side effects.

### Known negatives

These are just as important. Include PRs where the suspicious pattern is intentional or safely handled:

- a component stays mounted but an effect resets state;
- a cache is deliberately global and documented as such;
- the server derives the tenant from the authenticated session;
- a stale response is ignored by a request id or abort signal;
- a key is absent because the state is meant to survive navigation;
- a broad refactor changes names without changing behavior.

A reviewer that only sees bugs will learn to manufacture them.

### Near misses

Create fixtures where the same scenario is real but the PR does not introduce it, or where the impact is too small to report. These test whether the agent understands causality and severity rather than matching patterns.

### Mutated variants

Take a correct implementation and inject one controlled defect: remove a cache-key component, move a reset, drop a predicate, or delay a cancellation. The pair should differ by one behavior. Mutation tests are useful because they let us measure whether a change to the investigator actually improves detection of the targeted class.

## Use a two-level oracle

The first oracle is deterministic where possible:

- does the cited file and line exist in the PR?
- does the evidence symbol exist?
- is the reported line changed or within the allowed review range?
- does the scenario mention an entity found in the product model?
- does the validator's trace contain all required transitions?

The second oracle is human judgment. For each candidate, label:

- `correct`: real issue, introduced by the PR, actionable;
- `incorrect`: the alleged behavior does not occur;
- `not_introduced`: real issue, but it existed before the PR;
- `low_value`: technically true but not worth a review comment;
- `unsupported`: conclusion may be true, but the supplied evidence does not establish it.

An LLM judge can help cluster and prioritize candidates, but it should not be the only judge for the benchmark. Macroscope's own public benchmark combined LLM classification with manual verification and acknowledged that full manual validation was impractical. [Macroscope benchmark methodology](https://macroscope.com/blog/code-review-benchmark)

## Metrics that protect direction

Track these per fixture class, language, model, and review mode:

- precision of published findings;
- recall of known bugs;
- severity-weighted recall;
- false-positive rate on known negatives;
- `not_introduced` rate;
- evidence coverage, meaning the share of scenario claims with valid citations;
- scenario validity, judged independently of the prose;
- comments per PR;
- user acceptance or dismissal rate;
- latency and cost.

The most important early metric is precision of published findings. A reviewer that finds more bugs by flooding the author with guesses is moving backward.

## Counter-review loop

Every candidate should pass through a deliberate opposing review:

```text
investigator proposes scenario and finding
        |
        v
counter-reviewer tries to break the scenario
        |
        +--> missing evidence -> investigate again or abstain
        +--> behavior existed before PR -> reject
        +--> safeguard found -> reject
        +--> reachable regression with impact -> accept
```

The counter-reviewer should not rewrite the finding. Its job is to attack it. Give it explicit prompts such as:

- “Find the earliest step in this scenario that is not supported by code.”
- “Search for a reset, guard, abort, cache scope, or server-side check that defeats this claim.”
- “Compare the base revision and head revision. What behavior changed?”
- “What is the smallest input and user sequence that reproduces this?”
- “If this is true, which existing test should fail or be added?”

Use a separate model or at least a separate context and role. Agreement between two calls using the same flawed context is weak evidence.

## Regression gates

Do not accept a new investigator or prompt because one example improved. Require it to:

1. improve or preserve recall on positives;
2. not reduce precision on negatives;
3. keep evidence coverage above the project threshold;
4. avoid increasing comments per PR without a corresponding gain in accepted findings;
5. pass held-out fixtures that were not used to tune the change.

Keep a small “must not regress” suite in the repository. Run it on every change to the context builder, agent roles, schemas, routing policy, or renderer.

## Shadow mode before comments

For the first real use, run the reviewer in shadow mode. It records what it would have reported but does not post to GitHub. A human compares its candidates with the actual review and labels each one. After enough examples, enable advisory comments only for high-confidence findings with complete evidence.

The feedback buttons should ask a useful question: “Was this a real issue introduced by this PR?” A separate option should capture “real but low value.” That distinction teaches the system signal, not just silence.

## What good progress looks like

The investigator is heading in the right direction when its comments become fewer, more reproducible, and more tightly connected to a concrete user journey. A good weekly report should show the fixture counts, precision, recall, accepted comments per PR, abstentions, and the top rejected hypotheses. The rejected hypotheses are where we learn what the agent is misunderstanding.

