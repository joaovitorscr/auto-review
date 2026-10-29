# Plan of action

## Reference adjudication and a plain rerun (2026-10-29)

Each of the 32 Macroscope comments on the 20 t3code holdout cases was checked against head
(verdicts in each git-ignored `case.json` as `verdict`): **9 correct, 10 incorrect, 9 low value,
4 not introduced**. Macroscope's precision here is about 28%, so recall of its comments was
never the target. 4 of the 5 silent unseen cases had no real bug (13725, 13887, 14184, 14616);
14368 has one Low. 13726:1932, the line every prompt variant rated "none", is not introduced.

The same check corrected our labels: 14412:35 and 13879:728 are low value, 14636:7612 is
incorrect (the outbox runs one non-title effect per thread at a time), and 13901:583 is
Macroscope's 13901:135. Unseen precision is **9 correct, 1 low value, 1 incorrect** of 11, and
we hold 2 of Macroscope's 9 correct comments (13863:164, 13901:135).

Plain rerun (note "t3code unseen, plain rerun"; one usage-limit stop): the unchanged detector,
once more, on the five unseen cases holding a correct Macroscope comment we missed (13877,
13948, 14239, 14368, 14636). Keep a union of two samples if the second recovers ≥ 2. Result:
**1 of 5** (14636:179, Claude's interrupt with no live query). The other four findings repeat
the first sample exactly, including the incorrect 14636:7612; 14368 stayed silent. A second
low-effort sample mostly repeats the first, so the union is dropped. Missed correct bugs left:
13877:7973, 13948:5778, 14239:3, 14368:59 (unseen), 13792:6553, 13895:905 (dev).

Second look, reverted (note "t3code unseen, second look"; detector passes replayed, one live
pass per case). After the detector, one Codex pass took up to three survey entries rated "none"
(production files, away from candidates, one per hunk, biggest hunk first), hid the verdict, and
asked for a concrete counterexample at each: boundary input, early or late event, interruption,
a switch of provider, account or mode, a stale value. Same five cases; keep if ≥ 2 new correct
bugs and it beats the plain rerun. Result: **0 new bugs on four cases**, 14636 timed out at five
minutes. Its two candidates repeat bugs the detector already had, reached from another hunk.
Twice the missed line was in focus and still came back "none": 13877 tried a double-click at
the Resume handler, not a mode change; 14368 worked out that OpenCode 2.0.17 resolves to
"unknown" and called that fine. Neither focus, a second sample, nor any of the earlier prompt
wordings changes the verdict at a line the detector has already read.

## Precision on unseen cases (2026-10-29)

Twelve one-pass t3code cases never run before, current prompt, Codex low effort, detector-only
(note "t3code unseen, precision"; two usage-limit stops, 7 passes per window). Predictions were
precision ≥ 70%, ≥ 3 correct bugs Macroscope missed, ≤ 2 Macroscope matches. All held:

- **11 candidates, 11 correct** (9 distinct bugs; 13949 repeats 13948's two, since it shares that
  code). 362 rests on Effect's `basicAuth` using `btoa`, which was not read locally.
- **7 correct bugs Macroscope did not raise**, 6 of them new: a manual resume outranks queued runs
  by ordinal (13877), recovery pools every provider's cancelled work onto one run (13901), Claude
  wake reports survive the drain that consumed them (13948; Macroscope flagged the same pattern
  in the ACP adapter), a mixed summary says a passing command failed (13948), the probe's
  basic auth drops UTF-8 (14239), the manifest recommends the OpenCode 2 the driver rejects
  (14239).
- **2/20 Macroscope comments by content** (14412:34, 14636:177), both Medium. 5 of 12 cases had
  no candidate.

The reviewer is precise and finds bugs Macroscope does not; overlap with Macroscope measures a
different reviewer's taste. Precision and correct bugs per case are the metrics from here. The
open question is silence: 5 of 12 cases returned nothing, and whether those PRs hold real bugs
is unknown.

## Holdout baseline (2026-10-27)

First run on cases never tuned on: 7 one-pass t3code cases, Codex low effort, detector-only
(`pnpm progress -- runs`, note "t3code holdout baseline"; 14187 hit the usage limit). Prediction
was ≥ 6/15. Result: **2/11 correctness comments by content** (Critical 1/1, High 1/10; the
other 4 references were convention notes, now dropped by the miner), from 4 candidates total. Both
non-matching candidates are well evidenced; unlabeled.

Every miss was visible. 6 of the 9 missed Highs have a survey entry at or near the commented line
rated "risk none"; the detector spends 27-89s per PR and writes 2-19 survey lines, about one per
hunk. The missed Highs are lifecycle and concurrency traces (stale payload overwrites a rollback,
process group outlives an interrupted scope, PID reuse). It looks, then does not trace.

High effort, same cases (note "t3code holdout, detector-only, high effort"; usage limit after
13879). Prediction ≥ 4/11 failed: **by content still 1/6 on the five cases that ran** (the
Critical), though 5/6 by location. 13735, 13792 and 13879 each got one candidate at the
commented region describing a different, concrete bug (recovery skips the child thread; stop leaves
native subagents running; an inspection failure lets a live owner's child be reaped). Low effort
had found 13879:178; high effort did not. Effort moves where the detector looks, not whether it
finds Macroscope's bug.

The detector prompt's checklist (input shapes, UI state, sibling guards) comes from Acme misses;
it says nothing about interruption, cleanup ordering or races, which is where every t3code High is.

Labelled: of the 8 candidates, 6 are correct (3 of them bugs Macroscope missed), 2 low value, none
incorrect. Precision holds; recall against Macroscope is the gap.

Traced survey, reverted (2026-10-28; note "t3code holdout, detector-only, low effort, traced
survey"; usage limit after 13879). Each survey entry had to write the ordering most likely to break
the change (interruption, retry, early or late event, failed dependency) before rating it "none".
Prediction ≥ 4/11 failed: **1/7 by content on the five cases that ran**, against the baseline's 2/7
there. It re-found the 13879 owner-inspection bug and added one low-value candidate. On 13726 it
surveyed the exact commented line and traced the normal order (tool call, then permission) instead
of the breaking one (permission before the `task` part registers). Writing an ordering down does
not make the detector pick the ordering that breaks.

Lifecycle questions, reverted (2026-10-29; note "t3code holdout, detector-only, low effort,
lifecycle questions"; all 7 ran). One checklist clause asked, at every changed handler, stop,
cleanup, recovery or restart path: what if this arrives before the state it reads exists, after it
was replaced by a newer instance, while the scope is interrupted before cleanup registers, or after
a concurrent change it overwrites from a stale read. Prediction ≥ 4/11 failed: **1/11 by content**
(the Critical), against the baseline's 2/11. 4 candidates: 3 correct (2 of them bugs Macroscope
missed: a recovered subagent's ordinal counter restarts at 100 and interleaves resumed items; the
13879 owner-inspection bug again), 1 low value. On 13726 the survey again rated the exact commented
line (1932, "looks up permission tool names in the asking session's active turn") "none", though
the clause asked that very question.

Three prompt variants (baseline, traced survey, lifecycle questions) and two effort levels all land
at 1-2/11 by content with high precision. Every run looks at Macroscope's lines and finds a
different real bug or none; no wording has changed the verdict at a commented line. Stop prompt
changes against this set: these 7 cases are now tuned on four times and count as dev.

Next: seed a second pass from the survey's "none" entries on changed lines, which tests whether a
narrower question with one line in focus changes the verdict (doubles Codex passes), or accept that
overlap with Macroscope undercounts us and measure precision and novel correct bugs on unseen
t3code cases.

## Reset (2026-10-19, after a planning review with GPT-6-Astra)

Why it stalled: the score could not tell a better reviewer from a different score. Proximity
hits were counted as finds (latest acme-36 "6/12" is 5/12 by content: 5714 is credited to
5705), extras were never labeled, so precision was never measured, and the five Acme PRs were
tuned on (acme-36: 13 runs) while labeled holdout. Across 39 reference-scored runs about 12
of the 40 comments were never found by any approach; most effort went to the middle band
where single-run variance decides the result.

1. [x] `evals/progress.db` tracks every run, finding and label (see evaluation.md); history
   imported (101 results from 68 outputs). `--context-recall` now requires all of a comment's
   `needs` in one batch: 38/40 → 32/40. acme-36 has 7 split comments, but for 371 and 1347
   the query and its guarded sibling share batch 0; only the helper definition
   (analytics-service.ts:18, team-scope.ts:25) or the UI control sits elsewhere. 166 is split
   and still found 7/13, so a split is not fatal.
2. [ ] Label run #101 (acme-36) and the latest acme-37 run by hand. Precision baseline.
3. [ ] One effort check: Codex is hardcoded to low effort (`codex.ts:76`). Rerun acme-36's 4
   batches at high, 4 Codex passes, $0 Claude. Prediction: proposes 371 or 1347 without
   accusing a guarded sibling. If not, close cross-file work; if so, try focused context next.
   Result (`eval-1792444810066.json`, `--effort high`, 3 of 4 passes before the Codex usage
   limit, $0): **prediction failed**. Batch 0, which holds both server-side halves of 371 and
   1347 with their guarded siblings, surveyed 360 ("finds members with historical usage",
   risk none) and 820 ("includes historical contributors in dashboard member rows", risk none)
   exactly as low effort did. 19 candidates; by proximity the same hits as low effort (741, 771,
   2176, 5714/5705), no false accusation against a guarded sibling, and three more
   management-routes findings near 741/771. Batch 3 (pass 4) holds neither comment, so the
   missing pass cannot change the verdict. Cross-file Highs 371 and 1347 closed; effort stays
   low by default.
4. [ ] Relabel the Acme cases `dev`; take 2-3 unseen PRs as the real holdout before adopting
   any change.

Stop: a prompt clause per miss, proximity as correctness, judge replays as detector evidence.

# Plan of action (rewritten 2026-10-12)

Goal: a reviewer that posts the few bug comments a developer trusts, Macroscope-style. The old
plan optimised recall of Macroscope's comments by re-running paid detector and judge passes
per prompt tweak. Fifty-five runs and about $65 of Claude (plus most Codex windows) moved
posted recall from roughly 25% to roughly 30%. The strategy below replaces that loop.

## What the data says (2026-10-12)

- Reference set: 40 Macroscope comments on five Acme PRs (31, 34, 35, 36, 37). Comments
  carry severity (High/Medium) and, where needed, `anchors` (other lines the same bug can be
  reported at) and `needs` (head ranges a reviewer must see to find it).
- By kind of reasoning needed (best detector run, by content): input-shape vs sink 6/7, local
  hunk reading 4/4, UI state lifecycle 7/11, platform/library knowledge 3/5, concurrency 3/5,
  **cross-file consistency 1/6**, business semantics 0/2, files we skip (SQL) 0/2.
- Three of the four missed Highs are cross-file: a sibling route applies a guard or filter
  that the changed one does not.
- `--context-recall` (no model) showed why: the retrieval already reached the needed code,
  the packer dropped it. The diff was charged against the 400k pack budget (acme-36: 377k of
  diff, 11 snippets kept, 3,832 dropped). Fixed in `93a1bc1`, `5df804a`: 28/40 → 33/40
  comments fully visible, detector passes 11 → 4 (acme-36) and 10 → 3 (acme-37).
- The judge cost more than it returned. Its remaining value, parking hand-built-request
  findings as low and setting severity, is now defined in the rules; three replays of the
  same prompt agreed finding for finding, so sampling variance is small.
- Macroscope rates most of its own comments Medium (13/14 on acme-37, 8/12 on acme-36).
  Developer decision: prioritise the big bugs; posted output leads with highs, caps mediums,
  notes lows.

## Working rules

1. **Offline first.** Any change to retrieval, packing or batching is judged by
   `pnpm eval -- --context-recall --split all` before a model sees it. Visible comments is the
   leading metric; it is free.
2. **One paid run per hypothesis, prediction written first.** State what the run should show
   and the pass count and cost; get a yes. If the prediction can be checked offline, no run.
3. **Detector-only for big PRs, then `--replay`.** Codex passes are the scarce resource; the
   judge can be replayed from saved passes for one Claude pass.
4. **Label before tuning.** When a reference comment is missed, first record its `needs` and
   check visibility. Only a visible-but-missed comment is a model problem.
5. Cost rules from the old plan still hold: one case at a time, Codex ~12 passes per window,
   never a multi-case paid run without approval.

## Phase A — context the review needs (offline, in progress)

- [x] `--context-recall` with per-range reasons (skipped file / dropped by pack budget /
  packed, dropped by batch / never retrieved).
- [x] Snippet budget separate from the diff; long symbols as windows; base after one-hop
  context; relevance-ordered 240k batches.
- [x] SQL, prisma and graphql files reviewed as text (`d294d51`): acme-37 14/14 visible.
- [x] Own-file head snippets leave out the lines their batch's patch already shows (2026-10-19).
  No snippet was a full duplicate (hunk ±15), but 30-76k characters per batch were patch lines
  repeated inside snippets; trimming them took snippets per batch from 60-100 to 125-325 at the
  same pass count. `--context-recall` now counts a range visible when one batch shows every line
  from snippets or patches; the old single-snippet rule had under-counted 34:1495 and 36:2176.
  Recall 34/40 (old metric) → 36/40 (new metric, old packing) → 38/40; recovered 35:349 and
  36:5714 (query-client now shares the workspace-pages batch; its `needs` was 1-60 on a 51-line
  file, fixed to 1-51). Side effect: readFirst counts only context beyond the patch, so
  acme-36 part 2 now flags management-routes.ts. Untested with a model; predicted to keep or
  add hits on acme-36, never to lose 2176/771/741.
- [ ] Sibling retrieval for the cross-file row: for a changed route, query or handler, pack
  the siblings in the same module and the guard/filter helpers they call
  (`canReadTeamData`, `trustedUsageFilter`, `eq(workspaceMembers.status, ...)`). Static,
  no model. Measure with `--context-recall` on 36:371, 36:1347, 36:285, 34:1495.
- [ ] Label `needs` for the comments that still use the default (own line only).

## Phase B — one paid check of the new packing (ran 2026-10-12)

Prediction written first: with 8/12 visible and 4 passes on acme-36, the Codex detector
proposes ≥ 6/12 by content (was 4/12) including 371 or 1347. Run detector-only (4 Codex
passes, no Claude), then one judge replay (~$1).

Result (`outputs/eval-1791850468382.json`, 4 Codex passes, $0 Claude): 11 candidates,
**3/12 by content** (741 via team-import.ts:55, 771, 2176 at the exact line), 8 extras,
neither 371 nor 1347. Prediction failed. Of the 9 misses, 3 were not visible (285, 312,
5714) and **6 were fully visible and still missed**: 97, 166, 585, 5705, 371, 1347. Per rule
4 that is a model problem. The two cross-file Highs sat in the same batch as the sibling
guard/filter and the model still reported only local effects (984: former members' device
data as zero, next to 371's missing `trustedUsageFilter`).

Judge replay (`eval-1791902560138.json`, $0.89): accepted all 11, posted 3 highs + 6 mediums,
posted recall 3/12. Baseline row updated.

Follow-up (2026-10-13): added a detector instruction to compare a changed route, query or
filter with its siblings and report a guard or filter the siblings apply that it does not.
Prediction: proposes 371 or 1347, keeps the three hits. Result (`eval-1791903196262.json`,
4 Codex passes, $0): 10 candidates, **4/12 by content** (741, 771, 2176 via 1685, and 166
back via worker/alerts.ts:45), one new sibling-filter finding (report-data.ts:78 omits the
trust filters the download query applies), still **neither 371 nor 1347**. The survey shows
the model looked at both: line 360 "finds historical contributors for scoped dashboard
membership, risk none" (that query is the one missing `trustedUsageFilter`) and
team-scope.ts:25 `canReadTeamData` "risk none" (the dashboard route never calls it). So the
code was visible and inspected; the model did not recognise the omission. Instruction kept
(no cost, one real finding, one recovered comment).

Option (a), tried 2026-10-14, offline first. Two static tables over the AST index:
- Sibling helpers (same file, same parent, calls to repository symbols the siblings make and
  the changed function does not): 30-100 lines per PR, dominated by format helpers in page
  components, and it never surfaced `canReadTeamData` for the dashboard route because only 2
  of 10 sibling routes call it (5 of the 8 team-scoped routes in that file skip authorization,
  so the codebase itself gives no majority). Dropped.
- Companion calls (a changed call whose other sites in the repo sit within 3 lines of a second
  call this site lacks, ≥3 other sites, ≥60% paired): ~12 lines per PR, names 36:374
  "usageTeamScopeFilter without trustedUsageFilter; 7 of its 11 other call sites pair them".
  Shipped as `change.notes` (`f892ef0`, ~1k chars on acme-36) with a prompt sentence.

Paid check (`eval-1791994005172.json`, 4 Codex passes, $0). Prediction: proposes 371, keeps
the four hits. Result: 13 candidates, **5/12 by content** (741, 771, 2176, 166, and newly 5714
stale caches after team mutations), 8 extras, **371 still not proposed**: the survey entry for
line 358 reads "includes historical usage owners in dashboard member selection, risk none"
with the note in the same batch. The model reads the omission as harmless for a member-id
query. Third miss on 371 by three different routes (packing, instruction, explicit note); the
pairing notes stay because they are free and the run added one comment with no new noise,
but 371 and 1347 are now closed as "needs a stronger model or a human". Next: Phase C/D.

## Phase C — shrink the judge

- [x] Severity set by the detector pass; judge optional (`+judge`), off by default. Saves ~$1
  per PR. Checked offline (2026-10-19) by replaying acme-36's saved passes with no judge, $0:
  `eval-1791850468382` posts 3/12 (the judge replay `eval-1791902560138` also posted 3/12; the
  only differences are 3681 posted as medium where the judge said low, and 462 moved under the
  cap); `eval-1791994005172` posts 4/12 with 2 more hits held back by the medium cap. No code
  rule for hand-built requests: the detector already rates them low by the shared severity
  definitions, and the judge never moved a candidate on that ground. The detector prompt still
  says a counter-reviewer filters its output, on purpose. Measured 2026-10-20
  (`eval-1792527010660`, 4 Codex passes, detector-only): telling the detector nothing filters
  its output dropped acme-36 from 13 candidates and 6/12 location hits to 8 and 3/12, losing
  5714 among others. The proposer framing buys recall; keep it until the posted volume on real
  PRs says otherwise.
- [x] Medium cap dropped (2026-10-19, developer decision): highs first, then every medium under
  one heading, lows noted. Confidence sat at 0.95-1.0 on nearly every candidate (hit mean 0.976,
  miss 0.964), so the cap cut at random: on saved runs it lost 5714 on acme-36 (4/12 → 6/12
  posted, 13 comments) and 6 of 8 hits on the all-medium acme-37 run (22 comments uncapped).
  Macroscope posts 12-14 on these PRs. Watch posted volume on real PRs in Phase D.

## Phase D — real PRs, not fixtures

Five PRs from one repo is a fixture. Post highs only on the developer's own PRs via the
GitHub adapter, record whether each comment was acted on, and let that replace Macroscope
overlap as the metric. Stable packing and a cheap pass count are the prerequisites; both
exist now.

## Open items

- `evals/baseline.json` rows predate the packing change; regenerate when Phase B runs.
- acme-37 comments were left on a later commit than the case head; lines differ. Anchors
  cover the matched ones; 243, 331, 1059, 121, 994 still need anchors or a case re-cut at
  commit d82f8630.
- 1Password SSH signing intermittently fails (`failed to fill whole buffer`); retry commits.
- Spend to date (Claude, API-equivalent on the plan): $61.55 recorded + ~$3.50 unrecorded.
