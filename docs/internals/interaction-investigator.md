# Interaction investigator

## The job

The interaction investigator answers one question:

> Given this change, what can a real user do differently, and does that behavior remain correct across the boundaries this application cares about?

It should discover those boundaries from the repository. The user should not have to preconfigure a rule saying that `workspaceId` matters. If the code contains workspaces, tenants, organizations, projects, accounts, roles, or feature flags, the investigator should notice them and use them when planning its review.

This is a review-time product model, not a claim that the agent has understood the whole business. Every inferred fact needs a source and a confidence level.

## The protocol

```text
1. Reconnaissance
2. Build a temporary product model
3. Classify the PR's behavior change
4. Generate interaction hypotheses
5. Gather only the evidence needed for each hypothesis
6. Simulate the scenario through the code
7. Try to disprove the result
8. Publish only an actionable, evidenced finding
```

### 1. Reconnaissance

Before reviewing the diff, inspect the repository's local instructions, package manifests, routes, schemas, tests, seed data, and recent history. Then inspect the changed symbols and their direct callers and callees.

The index should expose facts, not just chunks of text:

- symbols and their definitions;
- imports, calls, implementations, and references;
- route and event entry points;
- state declarations and state setters;
- API requests, mutations, database queries, and cache operations;
- authorization checks and identity or scope parameters;
- tests that exercise the changed behavior;
- feature flags, configuration, and migration boundaries.

Tree-sitter is a practical first parser because it provides concrete syntax trees across languages and updates them incrementally. Where a language server is available, use its definitions, references, call hierarchy, and type information to improve the index. [Tree-sitter introduction](https://tree-sitter.github.io/tree-sitter/index.html), [Language Server Protocol](https://microsoft.github.io/language-server-protocol/)

### 2. Build a temporary product model

The model is a small set of entities, boundaries, actions, and invariants extracted from code. It should look like this internally:

```json
{
  "entities": [
    {
      "name": "workspace",
      "identifiers": ["workspaceId", "currentWorkspace"],
      "sources": ["src/workspaces/useWorkspace.ts:4-38"],
      "confidence": 0.94
    }
  ],
  "boundaries": [
    {
      "kind": "tenant",
      "keys": ["workspaceId"],
      "enforced_by": ["src/api/notifications.ts:12-31"],
      "confidence": 0.81
    }
  ],
  "actions": [
    { "name": "switch workspace", "evidence": ["src/layout/WorkspaceSwitcher.tsx:20-62"] },
    { "name": "add notification recipient", "evidence": ["src/notifications/NotificationDestinationCard.tsx:10-94"] }
  ],
  "candidate_invariants": [
    {
      "text": "notification form values must belong to the selected workspace",
      "evidence": ["src/api/notifications.ts:12-31", "src/layout/WorkspaceSwitcher.tsx:20-62"],
      "confidence": 0.68
    }
  ]
}
```

The model should distinguish direct evidence from inference. A variable named `tenantId` is evidence that the concept exists. It is not, by itself, evidence that all downstream queries enforce tenant isolation.

### 3. Classify the PR

The investigator should describe the change in behavioral terms before generating questions. Useful change types include:

- state lifetime or component identity;
- navigation, selection, or filtering;
- create, update, delete, or bulk actions;
- authorization or scope propagation;
- caching, invalidation, or optimistic updates;
- async loading, retry, cancellation, or concurrency;
- feature flag or rollout behavior;
- API, schema, event, or background-job contract changes.

One PR can have multiple types. The classification chooses which questions to ask and which repository tools to use.

### 4. Generate questions from the model

Questions should be generated from the changed behavior and discovered boundaries. They should be concrete enough to trace, not broad prompts such as “look for edge cases.”

For a PR touching a workspace-scoped form, the investigator might produce:

```text
- What happens if a user enters a recipient, switches workspaces, then clicks Add?
- Does the form state reset, remount, or get rehydrated from the new workspace?
- Does the mutation carry the selected workspace id, or can it use a stale closure?
- Does the server verify that the recipient belongs to the active workspace?
- What happens if the user switches while the save request is in flight?
- Do cached recipients from workspace A appear in workspace B?
```

The question generator should use a small library of transition patterns, then fill them with discovered entities:

| Pattern | Examples |
| --- | --- |
| switch scope | workspace, tenant, organization, account, project |
| change identity | sign out, impersonate, change user, change role |
| repeat action | double click, retry, back button, refresh |
| cross async boundary | navigate during load, cancel, stale response |
| cross rollout boundary | flag on/off, partial rollout, old client/new API |
| cross data boundary | cache, optimistic state, pagination, bulk selection |

The planner should rank questions by whether the PR touches the relevant boundary, how much harm a failure would cause, and how cheaply the code can establish an answer. It should stop when additional questions are unlikely to produce a distinct failure mode.

### 5. Gather evidence

Each question becomes a small investigation. The agent can ask the repository index for definitions and references, read focused source windows, inspect tests, search Git history, and run safe local checks. It should not load the whole repository into every model call.

Evidence should answer specific parts of the scenario:

```json
{
  "scenario": [
    "type recipient in workspace A",
    "switch to workspace B",
    "click Add"
  ],
  "claims": [
    {
      "claim": "the card keeps its local name state when workspaceId changes",
      "evidence": ["src/workspace/workspace-pages.tsx:5687", "src/notifications/card.tsx:14-28"],
      "status": "supported"
    },
    {
      "claim": "the Add request is sent under workspace B",
      "evidence": ["src/notifications/api.ts:8-22"],
      "status": "unknown"
    }
  ]
}
```

Unknown claims are not permission to guess. They trigger another lookup or cause the hypothesis to be rejected.

### 6. Simulate the scenario

The investigator should trace state and side effects as a sequence, with a location for every transition:

```text
initial state
  -> user action
  -> component or service identity
  -> state update / stale state / remount
  -> request, event, cache, or database side effect
  -> next user-visible state
```

Static tracing is the default. If the repository can run safely, the agent may add a focused test or execute an existing test, but execution is evidence for that case, not proof that the general behavior is correct. The first implementation should support static simulation and leave runtime probes as a later tool.

### 7. Try to disprove it

The validator should receive the scenario, product model facts, evidence, diff, and candidate finding. It should ask:

- Is the behavior actually changed by this PR?
- Is the scenario reachable from a real entry point?
- Does another reset, key, effect, server check, or cache scope prevent the issue?
- Is the alleged state or data truly shared across the boundary?
- Does the impact justify a review comment?
- Is the proposed fix consistent with the surrounding code?

The validator should return `accept`, `reject`, or `needs_more_context`. A finding is publishable only when the scenario is reachable, the changed code participates in the failure, and the impact is concrete.

### 8. Write the comment

The comment should read like a compact reproduction recipe:

```text
When [user action sequence], [specific state/data] from [scope A]
survives into [scope B] because [code path]. The next [action] then
causes [user-visible or production impact]. Reset/remount the state at
[location].
```

That format naturally produces the quality visible in the screenshot. It explains the interaction, the mechanism, the consequence, and the smallest remedy. If the agent cannot fill all four parts from evidence, it should stay silent.

## How it discovers that interactions matter

Do not rely only on names. Use several signals:

- repeated scope identifiers such as `workspaceId`, `organizationId`, `tenantId`, or `accountId`;
- selectors, switchers, route parameters, providers, and context objects;
- database predicates and API request fields that carry scope;
- authorization middleware and policy helpers;
- cache keys and query keys;
- tests that create multiple scopes or users;
- UI labels and issue text that describe switching or isolation;
- Git history where a past bug or fix introduced a boundary rule.

Multiple weak signals can form a strong hypothesis. One variable name should not.

## MVP implementation

Start with one investigator, one validator, and a read-only tool set:

```text
browse_code(symbol or file range)
find_references(symbol)
find_callers(symbol)
find_callees(symbol)
search_history(path or symbol)
read_tests(symbol or behavior)
run_safe_check(command)
```

The investigator should produce an internal trace and structured candidates. The validator should be a separate model call, ideally using a different model or a different role policy. The renderer should expose only the final explanation and cited locations.

The first evaluation set should contain interaction bugs, not only algorithmic bugs. Good examples include stale state after switching scope, stale async responses overwriting a newer selection, cache keys missing an ownership identifier, authorization checks applied to reads but not writes, and feature-flagged UI calling an incompatible API path.

