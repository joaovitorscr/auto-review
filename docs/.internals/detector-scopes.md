# Offline detector scope inventory

`apps/cli/src/review/scopes.ts` exports `planDetectorScopes(changes, sources, options)` for offline inspection. It takes existing `Change` metadata and a map of exact-head source files. It does not read files, execute repository code, call a provider, or change the production review path. The caller must supply matching revisions.

The inventory itself is head-only, **not a model-ready review payload**; its `modelReady` remains false. The opt-in adapter in `scoped-batches.ts` adds located diff rows, base evidence, and shared metadata, then packs labelled scopes into detector batches. No recall improvement has been established.

## Opt-in eval

Use `pnpm eval -- --agent codex+claude --split all --case <name> --scoped --dry-run --max-parts N` to inspect the exact plan without constructing or calling providers. Experimental scoped mode requires exactly one case and agent. Remove only `--dry-run` to execute the same preparation path after spending approval. Default reviews/evals remain unchanged. The CLI `pr review` command does not expose this experimental option.

Preparation fails before any provider call when primary evidence is unavailable/oversized, changed diff rows would be lost, a payload cannot fit, or the plan exceeds `maxParts` (default four). Empty/deleted changes without a surviving head anchor are currently unsupported and fail explicitly. There is no fallback to an unscoped paid run.

Diff rows preserve original base/head coordinates and additions/removals. Missing coordinates or gaps never imply adjacency. Base and head source evidence is retained in report context for citation validation. Optional support may be removed, with an explicit omission, to fit mandatory diff/base evidence within the 80,000-character serialized context cap. Prompt/schema overhead is additional, as with existing file batching. Scope boundaries stay labelled even when multiple scopes share a detector call. The counter-review receives independent context snippets as well as candidate citations and diffs. It prioritizes files from detector batches containing candidate anchors or cited files, then selects whole snippets in context order, deduplicates covered ranges, and caps snippet text plus metadata at 80,000 serialized characters. Omitted ranges are listed separately. This is an additional validator input budget, not a cap on its complete prompt. Eval output records detection mode, scope count and coverage.

The complete Acme case requires 11 detector batches after adding consumer and base comparison context, compared with ten before this change. This is a preflight measurement, not a paid evaluation or a recall claim.

## Selection

- Group adjacent touched statements, aiming for 12,000 serialized primary characters and 40,000 serialized payload characters. Compact overlapping or exactly adjacent primary source ranges before accounting, but never bridge an omitted gap. Enclosing-range metadata is emitted once per parent. These are experimental bounds, not validated settings.
- Split oversized function declarations and single-variable callable initializers at body statements, and oversized classes at member boundaries. Small `useCallback` declarations retain the entire wrapper and dependency array.
- Keep parent residual text and top-level trivia explicitly. Source ranges are located excerpts, not concatenated executable source. Parent ranges identify omitted intervening text. Unsplittable members, control-flow statements and JSX returns remain oversized rather than being cut arbitrarily.
- Assign each changed head line one primary anchor owner, but retain every unit intersecting that line. `relatedChangedLines` can overlap across scopes; `anchors` cannot. A same-line statement must not disappear merely because another statement owns its line.
- Use a same-file TypeScript checker for lexical references, including JSX identifiers and shorthand object values. Associate destructured sibling bindings syntactically, so a state setter can lead to the corresponding state read. This does not prove dataflow.
- Include complete supporting statements with their enclosing control flow. Inline callbacks retain their JSX consumer, and nested handlers retain captured declarations. Prefer consumers of primary declarations and referenced nested handlers, then other callable/JSX excerpts, then incidental reads, with smaller excerpts first within each group; when a larger enclosing excerpt fits, replace its contained supporting excerpts rather than duplicating them. Import declarations remain available, but unrelated uses of a shared import do not become consumer context. References are selected one hop from primary code, not recursively from every supporting excerpt. Imports, unresolved names, and context excluded by the budget remain explicit. There is no cross-file consumer graph.

## Reading the inventory

`requiredParts` counts the prototype's proposed groups if each became a detector call. It is **not** the current production pipeline's pass count. The prototype plans every supplied file; it does not implement the proposed large-file-only rollout or cross-file coalescing. `exceedsPartLimit` compares that count with a default of four, without running any calls.

`boundedHeadCoverage` means all supplied head anchors have owners, none of the primary units/payloads is oversized, source is available, and there are no syntax diagnostics. It does **not** mean all relationships or base changes are covered, nor that the part cap is satisfied. Inspect `omitted`, `unresolved`, `unowned`, `unavailable`, `oversized`, and `exceedsPartLimit` separately. Deleted files with no head anchors remain unavailable, not silently complete.

`characters` measures `JSON.stringify(scope.payload)`. Inventory diagnostics and any future prompt/schema overhead are outside that payload. Oversized primary evidence is retained for inspection, explicitly flagged, and is never a permissible model payload merely because it has an owner.

Tests in `scopes.test.ts` cover wrapper retention, state/JSX consumers, shadowing, shorthand values, same-line statements, unique anchor ownership, explicit gaps, budget omissions, syntax errors, deletion, coalescing and deterministic output. `scoped-batches.test.ts` additionally covers before/after coordinates, citation evidence, opt-in prompting and preflight failures without provider calls. The default production path remains file-batched.

## Before/after comparison and counter-review

Scoped batches add up to 12,000 serialized characters of complete same-file base declarations sharing calls or JSX components with primary head code. Shared operations appearing in fewer base declarations rank first. These are explicitly labeled comparison leads, not established semantic equivalence. They can connect renamed or replaced views beyond the rows assigned to a scope. Matching is syntactic and can miss rewrites or select unrelated uses. Budget omissions remain explicit, and mandatory diff evidence is retained.

An oversized enclosing declaration cannot replace the smaller supporting excerpts around its primary code. That avoids selecting a whole component only to discard it during final payload trimming. Support remains bounded and incomplete.

Validation receives independent snippets, including uncited callers, and must trace the account/configuration used by an error-producing operation and its remedy. Selected-account labels alone do not establish error provenance. Unresolved provenance requires abstention. No paid evaluation has established a recall improvement from these changes.
