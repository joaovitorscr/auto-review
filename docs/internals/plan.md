# Plan of action

## Reset (2026-10-19, after a planning review with GPT-6-Astra)

Why it stalled: the score could not tell a better reviewer from a different score. Proximity
hits were counted as finds (latest othos-36 "6/12" is 5/12 by content: 5714 is credited to
5705), extras were never labeled, so precision was never measured, and the five Othos PRs were
tuned on (othos-36: 13 runs) while labeled holdout. Across 39 reference-scored runs about 12
of the 40 comments were never found by any approach; most effort went to the middle band
where single-run variance decides the result.

1. [x] `evals/progress.db` tracks every run, finding and label (see evaluation.md); history
   imported (101 results from 68 outputs). `--context-recall` now requires all of a comment's
   `needs` in one batch: 38/40 → 32/40. othos-36 has 7 split comments, but for 371 and 1347
   the query and its guarded sibling share batch 0; only the helper definition
   (analytics-service.ts:18, team-scope.ts:25) or the UI control sits elsewhere. 166 is split
   and still found 7/13, so a split is not fatal.
2. [ ] Label run #101 (othos-36) and the latest othos-37 run by hand. Precision baseline.
3. [ ] One effort check: Codex is hardcoded to low effort (`codex.ts:76`). Rerun othos-36's 4
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
4. [ ] Relabel the Othos cases `dev`; take 2-3 unseen PRs as the real holdout before adopting
   any change.

Stop: a prompt clause per miss, proximity as correctness, judge replays as detector evidence.

# Plan of action (rewritten 2026-10-12)

Goal: a reviewer that posts the few bug comments a developer trusts, Macroscope-style. The old
plan optimised recall of Macroscope's comments by re-running paid detector and judge passes
per prompt tweak. Fifty-five runs and about $65 of Claude (plus most Codex windows) moved
posted recall from roughly 25% to roughly 30%. The strategy below replaces that loop.

## What the data says (2026-10-12)

- Reference set: 40 Macroscope comments on five Othos PRs (31, 34, 35, 36, 37). Comments
  carry severity (High/Medium) and, where needed, `anchors` (other lines the same bug can be
  reported at) and `needs` (head ranges a reviewer must see to find it).
- By kind of reasoning needed (best detector run, by content): input-shape vs sink 6/7, local
  hunk reading 4/4, UI state lifecycle 7/11, platform/library knowledge 3/5, concurrency 3/5,
  **cross-file consistency 1/6**, business semantics 0/2, files we skip (SQL) 0/2.
- Three of the four missed Highs are cross-file: a sibling route applies a guard or filter
  that the changed one does not.
- `--context-recall` (no model) showed why: the retrieval already reached the needed code,
  the packer dropped it. The diff was charged against the 400k pack budget (othos-36: 377k of
  diff, 11 snippets kept, 3,832 dropped). Fixed in `93a1bc1`, `5df804a`: 28/40 → 33/40
  comments fully visible, detector passes 11 → 4 (othos-36) and 10 → 3 (othos-37).
- The judge cost more than it returned. Its remaining value, parking hand-built-request
  findings as low and setting severity, is now defined in the rules; three replays of the
  same prompt agreed finding for finding, so sampling variance is small.
- Macroscope rates most of its own comments Medium (13/14 on othos-37, 8/12 on othos-36).
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
- [x] SQL, prisma and graphql files reviewed as text (`d294d51`): othos-37 14/14 visible.
- [x] Own-file head snippets leave out the lines their batch's patch already shows (2026-10-19).
  No snippet was a full duplicate (hunk ±15), but 30-76k characters per batch were patch lines
  repeated inside snippets; trimming them took snippets per batch from 60-100 to 125-325 at the
  same pass count. `--context-recall` now counts a range visible when one batch shows every line
  from snippets or patches; the old single-snippet rule had under-counted 34:1495 and 36:2176.
  Recall 34/40 (old metric) → 36/40 (new metric, old packing) → 38/40; recovered 35:349 and
  36:5714 (query-client now shares the workspace-pages batch; its `needs` was 1-60 on a 51-line
  file, fixed to 1-51). Side effect: readFirst counts only context beyond the patch, so
  othos-36 part 2 now flags management-routes.ts. Untested with a model; predicted to keep or
  add hits on othos-36, never to lose 2176/771/741.
- [ ] Sibling retrieval for the cross-file row: for a changed route, query or handler, pack
  the siblings in the same module and the guard/filter helpers they call
  (`canReadTeamData`, `trustedUsageFilter`, `eq(workspaceMembers.status, ...)`). Static,
  no model. Measure with `--context-recall` on 36:371, 36:1347, 36:285, 34:1495.
- [ ] Label `needs` for the comments that still use the default (own line only).

## Phase B — one paid check of the new packing (ran 2026-10-12)

Prediction written first: with 8/12 visible and 4 passes on othos-36, the Codex detector
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
  Shipped as `change.notes` (`f892ef0`, ~1k chars on othos-36) with a prompt sentence.

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
  per PR. Checked offline (2026-10-19) by replaying othos-36's saved passes with no judge, $0:
  `eval-1791850468382` posts 3/12 (the judge replay `eval-1791902560138` also posted 3/12; the
  only differences are 3681 posted as medium where the judge said low, and 462 moved under the
  cap); `eval-1791994005172` posts 4/12 with 2 more hits held back by the medium cap. No code
  rule for hand-built requests: the detector already rates them low by the shared severity
  definitions, and the judge never moved a candidate on that ground. The detector prompt still
  says a counter-reviewer filters its output, on purpose. Measured 2026-10-20
  (`eval-1792527010660`, 4 Codex passes, detector-only): telling the detector nothing filters
  its output dropped othos-36 from 13 candidates and 6/12 location hits to 8 and 3/12, losing
  5714 among others. The proposer framing buys recall; keep it until the posted volume on real
  PRs says otherwise.
- [x] Medium cap dropped (2026-10-19, developer decision): highs first, then every medium under
  one heading, lows noted. Confidence sat at 0.95-1.0 on nearly every candidate (hit mean 0.976,
  miss 0.964), so the cap cut at random: on saved runs it lost 5714 on othos-36 (4/12 → 6/12
  posted, 13 comments) and 6 of 8 hits on the all-medium othos-37 run (22 comments uncapped).
  Macroscope posts 12-14 on these PRs. Watch posted volume on real PRs in Phase D.

## Phase D — real PRs, not fixtures

Five PRs from one repo is a fixture. Post highs only on the developer's own PRs via the
GitHub adapter, record whether each comment was acted on, and let that replace Macroscope
overlap as the metric. Stable packing and a cheap pass count are the prerequisites; both
exist now.

## Open items

- `evals/baseline.json` rows predate the packing change; regenerate when Phase B runs.
- othos-37 comments were left on a later commit than the case head; lines differ. Anchors
  cover the matched ones; 243, 331, 1059, 121, 994 still need anchors or a case re-cut at
  commit d82f8630.
- 1Password SSH signing intermittently fails (`failed to fill whole buffer`); retry commits.
- Spend to date (Claude, API-equivalent on the plan): $61.55 recorded + ~$3.50 unrecorded.
