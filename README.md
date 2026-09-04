# Auto-review

An experiment in building a useful, model-agnostic pull request reviewer.

The goal is not to clone Macroscope's product. It is to reproduce the parts that appear to matter most for a small personal tool:

- give the reviewer enough repository context to reason beyond the diff;
- ask several focused agents to look for runtime bugs;
- validate findings before posting them;
- keep the output short, severe, and tied to a file and line;
- let the user choose the model and provider.

The interaction-specific design is in [docs/interaction-investigator.md](docs/interaction-investigator.md). It describes how the reviewer can discover concepts such as workspaces, tenants, and organizations from the codebase and derive user journeys without hard-coded project rules.

The evaluation plan is in [docs/evaluation.md](docs/evaluation.md). It defines counter-review, positive and negative fixtures, evidence-based scoring, shadow mode, and regression gates.

The first implementation is a Vite+ monorepo. It contains a TypeScript CLI, a React web app, and a shared package for GitHub data. The proposed reviewer design is in [docs/architecture.md](docs/architecture.md), and the external research is in [docs/research.md](docs/research.md).

## Run it locally

You need Node.js 22 or newer, [Vite+](https://viteplus.dev/), and an authenticated [GitHub CLI](https://cli.github.com/).

```sh
vp install
pnpm pr snapshot       # current branch's pull request
pnpm pr snapshot 123   # pull request number or URL
vp dev
```

The CLI writes `apps/web/public/pr.json`. The web app reads that snapshot and shows the pull request summary, changed files, and GitHub checks. This file-based handoff is intentional for the first version. It keeps GitHub credentials out of the browser and leaves room for a local API once review runs need live progress.

Useful workspace commands:

```sh
vp check
vp test
vp run -r build
```

## Working definition of success

For a personal repository, a review is useful when it finds a real correctness or security problem that ordinary tests missed, explains why it happens, and does not bury that finding in style comments. A first milestone is a local CLI that reviews a Git diff and emits structured findings. GitHub comments and multiple providers come after that works reliably.

## Proposed first build

1. Read a base/head diff and repository instructions.
2. Collect changed files plus relevant callers, callees, types, tests, and recent history.
3. Run a small set of independent detector tasks through a common model adapter.
4. Run a separate validator against each candidate finding.
5. Deduplicate, rank by severity and confidence, and render Markdown or JSON.
6. Save accepted and rejected findings as an evaluation record.

The project should start with one provider that speaks an OpenAI-compatible API, then add native adapters only when a provider needs different behavior. The reviewer must depend on a provider-neutral interface, not on one vendor's SDK.

## Non-goals for the first milestone

- automatic fixes or automatic approval;
- a hosted service;
- support for every language on day one;
- prompt auto-tuning before there is a labeled evaluation set;
- replacing tests, static analysis, or human review for high-risk changes.
