# AutoReview

An open-source code reviewer that runs locally and uses the coding agent you already have installed. It looks for concrete regressions by reading how a change interacts with the surrounding code, and it reports little else.

Status: early prototype. The local reviewer supports Codex only, reviews committed JavaScript and TypeScript changes, and has not yet been measured against a labeled set of real bugs. Treat its findings as leads, and a clean report as "nothing found", not "bug-free".

## Requirements

- Node.js 22.12 or newer
- [Vite+](https://viteplus.dev/) (`vp`) and pnpm
- [Codex CLI](https://github.com/openai/codex), logged in, for reviews
- [GitHub CLI](https://cli.github.com/), logged in, only for PR snapshots

## First run

```sh
git clone <this repository> && cd auto-review
vp install
pnpm pr review --base HEAD~1 --dry-run --output /tmp/context.json
```

The dry run builds the review context without calling an agent, so it is a safe way to check your setup. Paths are resolved from the AutoReview checkout; pass `--repo /path/to/repo` to review another repository.

## Review a branch

Commit the changes you want reviewed, then run:

```sh
pnpm pr review --base main
```

AutoReview checks out the merge base and HEAD into temporary Git worktrees, so your checkout is never modified. It collects the changed code plus AST-linked callers, callees, and imports, then runs a detector pass and a separate counter-review pass through Codex. Findings whose citations do not match the collected source are withheld.

The terminal shows accepted findings. A JSON report is saved under `outputs/` (or `--output path`) with the revisions, context, accepted and withheld candidates, and coverage limits. Staged, unstaged, and untracked changes are excluded.

Options: `--head ref` (default `HEAD`), `--repo path`, `--model id` to override Codex's configured model, `--dry-run`, and `--output path`. Reports stay on your machine, but Codex sends the collected source to its model provider.

## Other commands

```sh
pnpm pr index . --output /tmp/index.json   # dump the TypeScript/JavaScript AST index
pnpm pr snapshot [number-or-url]           # save a GitHub PR to apps/web/public/pr.json
pnpm run dev                               # dashboard that displays the PR snapshot
```

The dashboard shows PR snapshots (summary, timeline, and code). It does not display review runs yet.

## Development

```sh
vp check
vp test
vp run -r build
```

## License

[MIT](LICENSE)
