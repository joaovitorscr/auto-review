# Research notes

Last reviewed: 2026-09-04

## What Macroscope publicly says

Macroscope's code-review page describes four capabilities that matter to this project:

- AST walkers build a graph-based representation of the codebase.
- Issue-management context supplies the reason behind a change.
- Reviews focus on correctness and aim for high signal with few false positives.
- The product can summarize PRs, propose fixes, and automatically approve some PRs.

Its launch post adds that the code-walking layer follows relevant references across a codebase and can work across multiple repositories. Its later posts describe parallel agents and an auto-tune system that searches model, prompt, and language combinations.

The public descriptions do not reveal the implementation, prompts, graph schema, or production safeguards. We should treat the design below as an informed reconstruction, not as a claim about their internals.

## The most useful lessons

### Context beats a larger diff

A changed function is rarely enough. A reviewer may need its callers, the implementation of a dependency, the type definition, nearby tests, configuration, and the history that explains an odd-looking branch. A repository index should retrieve this context selectively so that token count does not become the design.

### Detection and validation should be separate

One model call should be allowed to be suspicious. A second pass should ask whether the suspected path is actually reachable, whether the behavior is a regression in the diff, whether the line reference is valid, and whether the impact is worth interrupting a developer. This is the main defense against noisy comments.

## Where the apparent "taste" comes from

The screenshot is a good example. The reviewer did not merely say that a React component might have stale state. It connected four facts:

1. `NotificationDestinationCard` owns controlled `name` and `email` state.
2. The card remains mounted while `workspaceId` changes.
3. React preserves state when the component keeps the same identity.
4. The Add action can therefore submit a recipient typed in the previous workspace.

That is a hidden product invariant: form state must not cross a workspace boundary. The proposed `key={workspaceId}` is small because the diagnosis is specific.

This kind of review likely comes from a behavior-reasoning loop:

```text
diff -> changed behavior -> affected state/data flow
     -> user transition or failure path
     -> violated invariant -> minimal fix
```

The invariant is usually not written next to the changed line. The agent has to infer it from names, route or workspace boundaries, call sites, tests, issue text, and existing conventions. That is why a raw diff prompt often misses these findings.

For our reviewer, "taste" should mean a collection of explicit checks rather than a mysterious personality:

- state lifetime: what survives remounts, navigation, retries, or tenant changes?
- interaction sequences: what happens after switching, going back, double-clicking, refreshing, or partially failing?
- ownership boundaries: can data, permissions, cache entries, events, or form values cross user, tenant, workspace, or request boundaries?
- contract chains: does the UI assumption still match the API, schema, feature flag, job, and persistence behavior?
- failure paths: what does the user see when loading, saving, canceling, or retrying fails?
- blast radius: which users or workflows are affected, and can the problem be reproduced?

The detector should generate a concrete scenario, not a vague concern. The validator should walk that scenario through the code and reject it if it cannot establish the transition. This is the closest small-project substitute for a human reviewer manually trying the feature.

### Model agnosticism is an orchestration problem

Different models have different output formats, context limits, tool support, latency, and calibration. A provider adapter can normalize API calls, but it cannot make all models equally good. The system needs explicit model profiles and a policy that can assign models to detection, validation, summarization, or repair.

### Quality needs a benchmark

Macroscope's published benchmark used known production bugs, mapped the introducing change to a reviewable PR, and measured detection rate and comment volume. It reports 118 runtime bugs from 45 repositories in the September 2025 evaluation. Its later auto-tune post says the internal set had grown beyond 500 labeled bugs and that severity-weighted scoring penalized false positives.

For this project, the first dataset can be small and personal. Keep examples of real bugs, the introducing diff, the expected explanation, severity, and whether a proposed comment was accepted. Never tune against the same examples used for the final score.

## What to copy, and what not to copy yet

Copy the shape of the system: repository context, focused agents, a skeptical validator, severity-aware output, and measurement. Do not start by building a full cross-repository graph, an auto-tuner, or an automatic fixer. Those features only pay off after the basic reviewer produces findings that a human consistently accepts.

## Open questions

- Which languages should get native AST or language-server support first?
- Should the first graph use tree-sitter, language servers, or a simpler symbol index?
- Which model APIs support tool calls, structured output, caching, and privacy requirements?
- How much repository content may be sent to each provider?
- Should a finding block CI, annotate a PR, or only appear in a report?
- How will feedback distinguish a wrong finding from a correct but low-priority one?

## Sources

- [Macroscope Code Review](https://macroscope.com/code-review)
- [Introducing Macroscope](https://macroscope.com/blog/introducing-macroscope)
- [Macroscope Code Review Benchmark](https://macroscope.com/blog/code-review-benchmark)
- [We (Basically) Stopped Writing Prompts](https://macroscope.com/blog/we-stopped-writing-prompts)
- [v3 Code Review](https://macroscope.com/blog/code-review-v3)
- [Expanding Detection Mode](https://macroscope.com/blog/expanding-detection-mode)
