# Local reviewer

The `review` command connects the AST index to Codex and writes a local review. It does not post to GitHub or update the dashboard; `post` publishes a saved report (see [Posting to a pull request](#posting-to-a-pull-request)).

```sh
# Inspect the exact model input without running Codex.
pnpm pr review --base main --dry-run --output /tmp/review-context.json

# Review committed branch changes and save the full decision record.
pnpm pr review --base main --output /tmp/review.json

# Target another local checkout or an explicit head/model.
pnpm pr review --repo /absolute/path/to/repo --base main --head feature-branch --model YOUR_CODEX_MODEL --output /tmp/review.json
```

Codex must be on PATH and logged in. The command uses its existing model configuration unless `--model` is supplied. Model inference uses that CLI's configured provider and account. No additional API key is required by AutoReview.

The command prints progress to stderr and a Markdown report to stdout. `--output` writes JSON containing the source context, findings, candidate decisions, coverage, commit hashes, context hash, policy version, requested model, and pass durations. A null requested model means Codex chose its configured default; the report does not claim to identify the resolved model. Without `--output`, completed reviews save a JSON record to `outputs/review-<head>-<timestamp>.json` in the AutoReview workspace. Explicit output paths resolve from the directory where the command was typed (pnpm's `INIT_CWD`). Report version 3 adds `status`: `complete`, `partial` when unsupported code or config files were skipped, context was omitted, or reviewed files have syntax diagnostics, or a tsconfig could not be resolved (docs, lockfiles, images and ignore files go to `coverage.ignoredFiles` instead), and `failed` or `cancelled` records that keep the revisions, provider, and error. The head worktree has no `node_modules`, so tsconfig `extends` packages are looked up in the original checkout's installed dependencies; a config that still fails falls back to default compiler options and is listed in `coverage.configErrors`. Ctrl-C aborts the Codex process and the worktree is removed; a second Ctrl-C force-quits. In dry-run mode, stdout or `--output` contains the context JSON instead.

## Revisions and source selection

`--base` is required. The comparison starts at the merge base of that ref and the head.

Without `--head`, a dirty working tree is reviewed as a snapshot. The Git adapter copies the index to a temporary `GIT_INDEX_FILE`, runs `git add -A` into it, and commits the resulting tree on top of HEAD with `commit-tree`. The snapshot includes staged, unstaged and untracked files and respects `.gitignore`. The caller's index, branch and files are untouched, and edits made while the review runs are not included. The snapshot commit is unreferenced, so `git gc` eventually removes it. The context and report set `workingTreeSnapshot: true`, which means `head` names that throwaway commit and not one in the branch history. A clean tree reviews HEAD. An explicit `--head` reviews only that commit and ignores local edits.

A temporary detached Git worktree supplies both the AST and the head source snippets. The AST covers only the changed files, the files whose import specifiers name one of them (a text search, so a superset of their importers), and the repository files they import as the compiler resolves them. That is what the one-hop context below needs; type-checking the whole repository took about 100 seconds on t3code, mostly vendored code, and now takes about 10. Pairing notes count only call sites inside this set. A tsconfig that fails to resolve is reported only when it governs one of these files. The command removes its worktree after completion or a handled error. Git checkout hooks are disabled for this worktree. It does not install dependencies or execute the project's tests. An abruptly killed parent process can leave a temporary worktree that requires manual cleanup.

The Git adapter extracts patches and changed head lines, with a nearest surviving head line as the anchor for a deletion. Paths come from Git's NUL-delimited output, and per-file diffs use literal pathspecs. Renames are represented as a deletion and an addition.

The context pack includes base/head hunk neighborhoods, enclosing changed declarations, one-hop callers and callees, call sites, dependencies, importing files, and applicable AGENTS.md files. Importing tests can enter through the same graph. It does not search every test or retrieve Git history beyond the diff. Imports receive up to their first 200 lines. Root and nested repository instructions are labeled as project evidence in the prompt.

The context budget is 400,000 characters for diff metadata, instructions and source snippets. A diff that already exceeds this limit fails instead of being truncated. Source ranges that do not fit are listed under `omitted`; syntax diagnostics and omission metadata can add a small amount beyond that budget. The report names skipped files and counts omitted ranges.

## Detection and counter-review

`run.ts` depends on a small `ModelProvider.complete` interface. The Codex process adapter owns CLI flags, stdin, output files, timeouts and errors. Each pass starts a fresh, ephemeral read-only session and requests JSON through `--output-schema`. AutoReview asks the model to use supplied evidence, avoid project execution, and perform no edits or external actions. Each pass has a five-minute timeout.

The detector looks for concrete runtime, security and compatibility regressions, including asynchronous state and user interactions. Candidates contain a severity, confidence, changed-file location, explanation, reproducible scenario, suggested fix and source citations.

Local checks withhold findings outside changed head lines or deletion anchors, findings without evidence, citations outside both the supplied source ranges and the head lines the agent read itself, and exact duplicates by path, line and normalized title. Confidence is recorded but does not gate publication: it sat at 0.95-1.0 on nearly every candidate. This does not detect every semantically duplicated finding.

Eligible candidates are published at the detector's severity: every critical and high, then every medium under its own heading; lows are listed as noted but not posted. A counter-review runs only when the caller passes a `validator` (the eval's `+judge`): a fresh session receives the candidates and the original context, tries to disprove each scenario, returns accept, reject or needs_more_context, and sets the final severity. It is off by default because on the eval corpus it accepted every candidate and kept the detector's level on all but one, at a Claude pass per PR. The JSON preserves every candidate and its decision. Invalid model output, a failed process, a timeout or missing validation decisions fail the command; they do not become a clean review. With no supported changes, no model is invoked.

## Current limits and evidence

This is an initial reviewer, not demonstrated parity with Macroscope. The two passes share a model and a bounded context, so they can share blind spots. Confidence is model-reported, not calibrated probability. Codex account token usage and monetary cost are not captured yet.

Every changed text file is reviewed. JavaScript and TypeScript also get AST context; everything else (SQL, JSON, other languages, patches) is reviewed as text, since schemas, manifests and fixtures decide what the code's inputs reach. Docs, lockfiles, images, binary diffs and recorded transcripts (`.ndjson`, `.jsonl`) are ignored; declaration files and generated/vendor directories are skipped. An entirely deleted file appears as its diff header and a removed-line count: it cannot receive a head-side finding, and its full text filled detector passes (t3code-14018 deletes 20.7k lines). The temporary checkout has no installed dependencies. Shared TypeScript configurations from repository workspace packages resolve directly from their source directories. Other package imports may remain unresolved, and tsconfigs extending unavailable external packages can prevent indexing.

Deterministic tests cover diff anchors, immutable revisions, merge-base behavior, caller retrieval, context limits, citation gating, rejected/uncertain findings, model-output failures, process timeouts, and worktree cleanup. A live Codex smoke test found and validated a removed cents-to-dollars conversion using an unchanged caller. A paired behavior-preserving refactor exercises the no-findings path. These small fixtures verify the flow; they do not measure production precision or recall.

## Review audit explanations

Report version 2 and policy version 2 require a structured audit for each detector finding and validator decision. Each audit saves factual observations referencing one-based entries in the finding's evidence array, a concise conclusion, counter-checks with supported/refuted/inconclusive results, and explicit uncertainties. These are evidence-based explanations for human review, not private model thought transcripts. The review method is static code review; these records do not establish execution of a reproduction or tests.

The detector audit is in `finding.audit`. The validator audit is in `records[].validatorAudit`. Locally rejected candidates retain the detector audit but have no validator audit because no validator examined them. Model-rejected and uncertain candidates retain both assessments. Invalid or missing audits, and evidence references outside the candidate's evidence array, fail the run rather than fabricate an explanation.

The graph displays both assessments beneath Evidence in the collapsed Review explanation section. It continues to accept version 1 reports with their original short validation reasons. Old runs are not backfilled; a new review is required to record structured explanations.

## Posting to a pull request

```sh
pnpm pr review --pr 42 --repo ../app --output /tmp/review.json
pnpm pr verify /tmp/review.json --repo ../app      # prove findings, writes /tmp/review.verified.json
pnpm pr post /tmp/review.verified.json --dry-run   # print the GitHub review
pnpm pr post /tmp/review.verified.json             # post it to pull request 42
```

`review --pr` asks GitHub for the pull request's base and head and fetches both into `--repo` without making branches, so a pull request stacked on another branch is reviewed against that branch, not `main`. The report records the pull request, and `post` posts there unless given another. `--base` and `--head` still review any two refs.

`verify` proves findings with tests (see "Verified on real PRs" in evaluation.md). It runs the pull request's code on this machine without prompts, one finding at a time, each capped at $5. It saves after every finding and stops on an agent error, so rerunning on the `.verified.json` file continues where it stopped.

`post` runs no model. It turns a verified report's `proven` findings at `--min` severity or above (default `high`, the Phase D policy; `medium` is the other option) into one GitHub review with event `COMMENT`, one inline comment per finding on the report's head line, each carrying its failing test, through `gh api` under the developer's own account. Without a pull request argument, `gh` picks the one for the current branch. Nothing is posted when no finding qualifies, which includes a report that was never verified.

It refuses failed or cancelled reports, working-tree snapshots, and a report whose head is not the pull request's current head commit, since its lines would land on the wrong code. Every comment and the review body end with an `<!-- auto-review -->` marker so a later pass can tell AutoReview's comments from the developer's.

Each inline comment follows Macroscope's layout: a severity and location header (`🟠 **High** \`path:line\``), the title, explanation, scenario and suggested fix, then two collapsed sections. One holds the failing test, and the other holds a prompt to paste into a coding agent, whose definition of done is that test passing.

## Watching a pull request

```sh
pnpm pr watch 42 --repo ../app              # keep pull request 42 reviewed until it closes
pnpm pr watch 42 --repo ../app --dry-run    # print one pass's decisions; no agent, nothing posted
```

There is no GitHub App, because inference runs on the developer's machine through their own agent. `watch` checks the pull request with `gh` every minute and posts as the developer, so it only works while that machine is running. A pass does three things:

- **New head.** It first reruns the saved test behind each open finding at the new head (`recheckProofs`: the test is applied as a patch, then the setup and bug commands run). A bug case that now passes gets a "Fixed in" reply and its thread is resolved. A test that fails some other way, or no longer applies, is left alone. Then it reviews the commits since the last reviewed head, or the whole pull request after a rebase. It drops findings within five lines of an open AutoReview thread in the same file, proves the rest as `verify` does, and posts them as `post` does. If the head moves during the cycle, nothing is posted and the next pass reviews again.
- **Replies** on AutoReview's threads are answered by the `--agent` in a read-only checkout of the current head. If the reply shows the finding is wrong, deliberate or fixed, the agent says so and the thread is resolved.
- **`/auto-review`** at the start of a conversation comment runs a full review of the current head. The comment gets an 👀 reaction, and a summary is posted when the review finishes. It is a slash command rather than an `@mention`, so it never notifies a real GitHub user.

Who can trigger it: the `gh` user, plus anyone GitHub reports with `admin`, `maintain` or `write` permission. A failed permission lookup counts as no access. Anyone else who uses the command, or replies on an AutoReview thread, gets one refusal. Bots and AutoReview's own comments (matched by the marker) are ignored. A push is reviewed without a command only when the pull request's author is trusted, because proving a finding runs the pull request's code on this machine. For anyone else's pull request, a trusted person decides by commenting `/auto-review`.

State lives in `outputs/watch/<owner>-<repo>-<number>.json`: the comments already handled, the last attempted and reviewed heads, and the posted findings with their saved tests. A restart neither answers twice nor re-reviews a head. Comments are marked handled before they are acted on, so a crash loses an answer rather than posting it twice. A failed review is not retried until the next push or `/auto-review`. On the first run, existing comments are history and a head that already has an AutoReview review is skipped. Findings posted by a manual `post` are answered in their threads, but are not rechecked on push, because their tests are not in the state file. Resolving a thread needs write access, so on someone else's repository the "Fixed in" reply is posted and the thread stays open. One pass runs at a time, so replies wait while a review and its proofs are running.

## Agents

`review/agent.ts` holds the agent-neutral contract (`ModelProvider`) and the shared process runner (stdin prompt, timeout, abort, stderr tail). Orchestration in `review/run.ts` has no agent-specific branches; `--agent` only picks the adapter.

- Codex (`review/codex.ts`): `codex --disable plugins --disable apps exec --sandbox read-only --ephemeral` with `--output-schema`; reports no model or usage. Codex has no strict MCP flag, so the adapter runs `codex mcp list --json` once (with plugins and apps disabled, which leaves only config.toml servers) and passes `-c mcp_servers.<name>.enabled=false` for each enabled one. `-c` keeps quotes in keys, so names outside `[A-Za-z0-9_-]` fail the review instead of being silently left on. Overriding a plugin-provided server creates an invalid entry, which is why plugins are disabled rather than overridden.
- Claude Code (`review/claude.ts`): `claude --print --output-format json --json-schema ... --tools Read,Grep,Glob --permission-mode dontAsk --no-session-persistence --strict-mcp-config`, run with the head worktree as cwd. It keeps the user's login (no `--bare`, which would require an API key). Reads `structured_output`; `is_error`, a non-success subtype, or missing structured output fail the pass. The model is the `modelUsage` entry with the most output tokens, since Claude Code also makes small helper calls. Input tokens include cache reads and writes.
