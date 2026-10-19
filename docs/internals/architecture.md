# Proposed architecture

## Design goal

Build a local-first reviewer with a stable core and replaceable model providers. The core owns Git, context selection, agent orchestration, validation, scoring, and output. Providers only implement model calls.

```text
Git PR / local diff
        |
        v
Change parser ---> repository index ---> context packer
        |                                  |
        +---------- review plan -----------+
                         |
              parallel detector agents
                         |
                 candidate findings
                         |
                    validator agents
                         |
                dedupe + severity filter
                         |
                 Markdown / JSON / GitHub
```

## Core components

### Change parser

Inputs are `base_sha`, `head_sha`, and repository settings. It extracts the unified diff, changed hunks, file language, symbols, added and removed lines, and whether generated or vendored files should be skipped.

### Repository index

Start with Git metadata, file paths, symbols, imports, and a cheap text search index. Add AST edges for calls, definitions, inheritance, and reads or writes as language support matures. Keep the index rebuildable. Stale graph data can create confident, wrong comments.

### Context packer

For each changed symbol, retrieve only the references needed for the review task. Include source snippets with stable file and line ranges, relevant tests, configuration, linked issue text when available, and focused Git history. Every context item should carry a source label so the model can cite it in its reasoning and the renderer can expose evidence.

### Provider-neutral model interface

The interface should be small enough to implement for any provider:

```ts
type ModelRequest = {
  system: string;
  input: unknown;
  tools?: ToolDefinition[];
  responseSchema?: unknown;
  maxOutputTokens?: number;
};

type ModelResponse = {
  output: unknown;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  raw?: unknown;
};

interface ModelProvider {
  complete(request: ModelRequest): Promise<ModelResponse>;
}
```

An adapter normalizes retries, timeouts, structured output, tool calls, usage, and errors. A model profile declares context limits, pricing, parallelism, and whether the provider can run tools. The reviewer should work with a single model or a routing policy such as `detector: kimi`, `validator: opus`, `summary: gpt`.

### Detector agents

Do not ask one general agent to "review everything." Run focused tasks over the same context pack. Early detectors can cover data-flow and boundary errors, error and concurrency handling, security and authorization, API or schema compatibility, and tests or rollout assumptions. Detectors must return JSON candidates, not prose:

For product behavior bugs, add an interaction investigator. It should construct short user journeys from the diff, such as "enter a value, switch workspace, click Add" or "submit, retry after a timeout." It then traces state ownership and side effects across the relevant components and services. This task is more likely to find a bug like state leaking between workspaces than a generic correctness prompt.

```json
{
  "kind": "runtime_bug",
  "severity": "high",
  "confidence": 0.86,
  "file": "src/cache.ts",
  "line": 42,
  "title": "Cache key omits tenant id",
  "explanation": "...",
  "evidence": ["src/request.ts:18-25"],
  "suggested_fix": "..."
}
```

### Validator

The validator receives the candidate, the original diff, and the cited context. It must try to disprove the finding. It checks that the issue is introduced by the change, the execution path is plausible, the impact matches the severity, and the line is actionable. It returns `accept`, `reject`, or `needs_more_context`, plus a short reason.

For interaction findings, require a scenario trace in the internal record:

```text
initial state -> user action -> component identity/state transition
              -> API or side effect -> observed wrong behavior
```

Only publish the finding when each arrow has evidence. This forces the reviewer to earn comments that sound like they were tested.

### Ranker and renderer

Deduplicate findings by location and underlying cause. Prefer one strong comment to several agent variants. Publish only findings above a configurable confidence and severity threshold. The renderer should include a concise explanation, impact, evidence, and an optional patch suggestion. Keep chain-of-thought private. Store only the decision reason and evidence needed for evaluation.

## Review modes

Use explicit profiles so cost and noise are visible:

- `budget`: one detector pass, lightweight context, no repair attempt;
- `balanced`: several detectors plus validation;
- `precise`: balanced plus a second validator or test-oriented check;
- `deep`: more parallel detectors, broader history, and stronger models.

These are policies, not claims that one model is always better. A cheap model may be good at broad candidate generation, while a stronger model may be better at rejecting weak candidates.

## MVP sequence

1. Local CLI, Git diff, one provider adapter, JSON output.
2. Repository instructions, context packer, and structured finding schema.
3. Detector plus validator with deterministic deduplication.
4. Markdown report and GitHub Check Run integration.
5. Small labeled bug corpus and precision, recall, comment-volume metrics.
6. AST or language-server indexing for the first two languages.
7. Provider routing and review modes.
8. Only then investigate prompt or policy auto-tuning.

## Safety and operating rules

- Never post a comment without a valid changed-file location.
- Default to advisory output. Do not auto-approve or auto-fix in the MVP.
- Redact secrets and let each provider have an allowlist of files and repositories.
- Treat repository instructions and issue text as untrusted input, not system instructions.
- Cache by commit, context hash, model, and policy version. Invalidate on any relevant change.
- Record latency, token usage, provider errors, accepted findings, rejected findings, and user feedback.

## Evaluation

Track precision, recall, severity-weighted recall, comments per PR, accepted-comment rate, latency, and cost. Split examples into development and held-out sets. A useful first scoring rule is:

```text
score = 125 * critical_recall
      + 25 * high_recall
      + 5 * medium_recall
      + 1 * low_recall
      - false_positive_penalty
```

The exact weights should be configurable. The point is to make a missed production outage matter more than a cosmetic nit, and to make noisy output expensive.
