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

### Mined Macroscope cases

Macroscope credits ran out, so new reference labels come from public repositories that already run it. `pnpm mine owner/repo --repo corpus/projects/<clone> (--pr N... | --into branch [--limit N])` reads a merged pull request's review comments through `gh` and writes `corpus/cases/<repo>-<number>/case.json`. Each case reviews the commit Macroscope first commented on, from its merge base with the base commit GitHub recorded on the pull request, since base branches get deleted. Its reference comments are Macroscope's correctness comments on that commit; check-run agent comments and convention notes (no severity marker, e.g. "import this as a namespace") are skipped. Locations Macroscope lists under "Also found in N other location(s)" become the comment's `anchors`. Each comment carries a `status` from Macroscope's own later edits: `resolved` (✅ Resolved in), `no_longer_relevant` (the code there changed) or `open` (merged unchanged). Acted-on comments are the stronger labels; an open one may be noise the maintainers ignored. Mining only reads GitHub. Clones under `corpus/projects/` are sandboxed: no remote (new commits are fetched read-only by URL and pinned under `refs/cases/<case>/`), `url."blocked-push-corpus-clone-is-read-only://".pushInsteadOf ""` so any push fails locally before contacting a server (a `pre-push` hook alone runs only after the connection), hooks that reject commit, merge and rebase, and a read-only working tree. New clones need the same setup. Reviews read their objects locally.

First batch, 2026-10-22: 42 sub-pull requests of pingdotgg/t3code#2829 (merged into `t3code/codex-turn-mapping`). 37 fit the 4-pass limit (27 need one Codex pass, 55 passes in total); 73 reference comments, 2 critical, 14 high, 57 medium, of which 36 were acted on (7 high). Indexing all of t3code takes about 1.5 minutes per case before any model runs.

Re-mined 2026-10-27: the first batch had kept 19 convention notes as Medium and dropped Macroscope's extra locations. Now 38 cases, 68 comments (2 critical, 21 high, 45 medium), 5 with anchors. Three of the four comments on `.ndjson` transcripts call valid JSON lines malformed; Macroscope's references are not ground truth.

### Telling whether a finding is true

A finding makes two claims, and they need different evidence:

- **Behaviour**: in some state, the code does the wrong thing. A test settles it: `reproduced` (fails before the fix, passes after), `refuted`, or `untested`.
- **Reachability**: a user or API client can get the code into that state. A test that constructs the state does not settle it. `shown` (an end-to-end path, or the maintainers say so), `argued_unreachable` (a named guard such as per-thread outbox serialization), or `unknown`.

Sources, strongest first:

1. **A maintainer's regression test**, replayed: run the test a fix commit added at the fix's parent and at the fix, in a scratch copy (never the corpus clone). Proves behaviour only.
2. **An unprompted later fix**: the code changed weeks later on main without a reviewer comment on that line (13877:69 and 13901:151 by t3code #15323). Strong for both claims, and independent of any reviewer.
3. **The author rejecting the comment** (13863:164: the unsandboxed retry is the point of the PR). Strong against.
4. **A fix right after a bot comment**: weak. t3code acted on 26 of Macroscope's 32 comments, including all 9 that model judges called low value and 7 of the 10 they called incorrect.
5. **One model judge**: weakest. On the test pilot it matched every behaviour verdict; its disagreements with the maintainers were all reachability arguments.

Pilot, 2026-10-29: 10 claims backed by maintainer tests, about 10 minutes, 6 filtered installs of 3-10 s from the shared pnpm store (3.7 GB scratch copy), no model. 8 reproduced, including all 5 the judges called correct and both bugs only we found. 13883:200 was refuted, matching the judges. 13877:68, 14187:1880 and 14636:177 reproduce only in states the judges argued cannot arise, and the tests construct those states directly, so their reachability stayed open (14636:177 was later shown reachable).

When no maintainer fixed a finding, an agent writes the failing test at the case head instead, driving the scenario through the project's own harness rather than private state, and runs it at base. A human reads the test before trusting it. First use, 2026-10-29, on our two unfixed 13948 bugs (still on main): both reproduce through the Claude adapter's mock CLI frames, with no constructed state, and neither exists at base. One wake summary shows both bugs: `Subagent "Agent B" and subagent "Agent C" were stopped`. It names B, which an earlier continuation already drained, and gives the successful C B's outcome. It took about 5 minutes of agent time and one filtered install.

Second use, 2026-10-30: the 8 labeled findings from the earlier t3code cases with no test yet, one agent per case and one process at a time. 1.5-4 minutes each, except 23 for the 13895 pair. 7 reproduced and 1 was refuted, and 3 of 8 reading-only labels changed. 13735:3557 was `correct`, but the adapter's reset ordinals never reach storage, because `TurnItemPositionStore.allocate` reassigns them from SQLite, so it is now `incorrect`. That is the first behaviour verdict a reading got wrong; the test pilot had none. 13735:3562 and 13895:89 were `low_value`, but maintainers fixed both later with tests no comment asked for (#18362, #15323), so they are now `correct`. An agent looking for the test found those fixes, and the original check never looked. The other five held. Reachability stays open on 13879:167 (the `ps` hang is injected), 13879:728 (it needs a leader that exited 0) and 13726:443 (it depends on what OpenCode does to a child after its parent errors). None of the 8 is in the 12 unseen cases.

Reachability test, 2026-10-30: 14636:7612 and Macroscope's 14636:177 are one bug, and we had called both incorrect because the outbox runs one effect per thread at a time. A test with real commands and the real effect worker reached it. Stop's interrupt fails with `has no live query`, the row returns to pending for its backoff and stops holding the thread's lane, the next message starts run 2, and a later retry settles run 2's background command as `interrupted`. Neither adapter error matches the worker's non-retryable filter. The adapter in the test is a fake that follows `ClaudeAdapterV2.interruptTurn`'s checks, and run 2 must settle within the 1.5 s of retries. Both are now `correct`, which moves unseen precision to 10 correct and 1 low value of 11. A guard argument needs the same test as a bug claim: this one held on the first attempt and failed on the retry.

### Verified on real PRs

The developer cannot read a test, so on real PRs the check has to be mechanical. A finding counts as proven when an agent's test, driven through the app's real entry points, fails at head for the claimed reason, a control in the same test passes, and a minimal fix turns it green. Run the test at base too, but do not require a pass there: a feature new in the PR has no base equivalent, so that check only separates pre-existing bugs.

`auto-review verify` runs this gate. For each finding at `--min` severity or above, one at a time, a Claude Code agent works in a throwaway clone with no remote and reports the test, the commands that run its bug case and control, and the failure text to expect. AutoReview then reruns them itself: the bug case must pass with the agent's fix, and on the reviewed commit without it, must fail printing that text while the control passes. A timeout is no result. Anything short of that is `untested`, a refutation needs its test to pass at the reviewed commit, and the test and fix patch are saved in the report for the fix agent. `post` publishes only `proven` findings, with their test. The rerun cannot check that a test drives the real entry points or that the failure matches the claim beyond the expected text, so those still rest on the agent, and reachability stays a separate question. First run, 2026-10-31, a two-claim throwaway repo on Haiku: one true claim proven, one false claim refuted, under $0.01.

Pilot, 2026-10-30, a private personal PR on an unfinished, local-only app, so it tests the mechanism and is not a measurement (one Codex pass, 7 findings; the 3 at high or above tested, one agent each, 1.5-5 minutes): 3 of 3 reproduced, and all 3 sit in code new in that PR, so none could pass at base. A rerun outside the agents gave the same failures. This does not show the gate rejects anything, since nothing was refuted. One agent's first test passed falsely because of a wrong form encoding, caught only by reading the server log, so a passing test refutes a finding only if it also shows the scenario really ran. The fix step is untested: only one of the three tried a fix.

t3code, 2026-10-31: the 4 unseen findings with no test yet, one agent per finding, each rerun unchanged by a second agent. All 4 reproduced at head with their controls passing, and a minimal fix turned each green. With the 7 already backed by a test or a later maintainer fix, all 11 unseen findings now have evidence beyond reading; labels stay at 10 correct and 1 low value. 14239:111 settles the `basicAuth` claim that had rested on memory of Effect's source, and it is worse than reported: a non-Latin-1 password also breaks the adapter. 13901:583 needed a second fix to pass, since recovery did not even load the older run's roster. 14412:35 stays `low_value`: `Unknown` only shows when no shell supplies the lineage edge, and `resolved_native` has no server writer, so one of the four statuses it named cannot occur. Reachability stays open on 14239:46. Nothing was refuted in this batch, so the only rejection so far is 13735:3557. These tests do not pass at base as a rule: the same 14239:46 test also fails there for another reason, and 13901 and 14412 have no equivalent, which is why base only separates pre-existing bugs.

First `verify` run on t3code, 2026-10-31 (note "t3code fresh, verify"): 7 one-pass cases never reviewed before, 2 of them PRs merged this week, Codex at low effort, no judge. They gave 3 findings, all medium, and `--min medium` proved all 3 in 3.6-7.5 minutes each for $4.91 total on Claude, with no human reading and no second agent. All 3 are `correct`, and all 3 tests also fail at base, which says nothing here. 14213:95 is the same bug as Macroscope's 14213:120 and main has since fixed it, so the 15-line proximity match counted a real overlap as a miss. 27998:1072 is still on main, but no first-party caller was found that reaches it with a DPoP token. 14488:4348 depends on a Grok notice the recorded transcripts do not contain. Nothing was refuted, so this run does not show the gate rejecting a wrong claim on real code. At the default `--min high`, nothing would have been posted. Of Macroscope's 7 comments on these cases, 3 sit in `.ndjson` transcripts we skip on purpose and 1 matched; the other 3 were missed, including a High on 27904: percent-encoded parameter names such as `%77sTicket` still write credentials to traces. 5 of the 7 reviews were `partial` for omitted context.

Running these needs memory more than CPU. On a 3 CPU, 3.7 GB, no-swap machine, three agents at once took the load to 58, left 159 MB available and took the machine down, and a 4-second version probe timed out, which would have read as a false failure. One agent at a time finished in 5.5 minutes on the web package. The server's integration test needed one worker thread, `--isolate=false` and a 600 MB heap. Run one at a time on small machines, and treat a hang or timeout as no result.

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

