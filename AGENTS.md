# AutoReview

AutoReview is a project to develop a AI Reviewer similar to Macroscope. He analyzes reviews and gives input based in the codebase context.

## A note from AutoReview contributors

Ambitious ideas, simple system and software that feels obvious are the core of how we wanna build this service. Do not preserve complexity jsut because it already exists or introduce machinery because it looks architecturally impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising.

Channel both "measure twice, cut once" and "yagni". Fight scope creep. Try to honor the dev's intent in both a minimal and realistic fashion.

The rest of this document is meant to help you navigate the codebase and make changes effectively. Think of these instructions less as "hard rules", more as "good defaults". The developer's preferences should be able to override anything here.

## Ways to hurt yourself

1. Killing by pattern. Never pkill -f, pgrep | kill, or kill a PID you found by matching a name, path, or worktree string. Your own agent process has this worktree's path in its argv, and this machine runs several other dev servers at once.

## Development Servers

Run development commands from the repository root so it can leverage vite plus

- `pnpm run dev` runs the web app dashboard
- `pnpm run pr` is the cli command to snapshot the PR (It uses github cli so the user connect to the cli needs to have access to PR)

## Verifying

- Use the smallest proof that the change works. Do not run every check in both layers unless I ask; CI owns the full suite.

## Pull Requests

- Never make a PR unless the developer explicitly asks you to do so.
- Conventional commit titles, plain language: fix(web): new threads no longer spike CPU.
- Body: the problem in a sentence or two, then how you fixed it. End with the model and harness that did the work.
- UI changes need before/after images. Motion or timing needs a short video.
- Upload PR evidence to GitHub. Never commit PR-only screenshots or assets such as .github/pr-assets/.
- One concern per PR. If the description says "also", split it.

## Plans and work artifacts

- Do not commit implementation plans, research notes, or agent scratch files. Keep temporary working material outside the worktree. .plans/ is gitignored only as a safety net for legacy tooling.
- Put durable architecture, constraints, and decisions in docs/.internals/. Update those docs when the product changes so agents find current facts instead of abandoned intentions.
- A merged PR is the implementation record. Close or update its tracking item when the work lands; do not preserve a second checklist in the repository.

## Where code lives

- Web app lives at apps/web
- CLI lives at apps/cli
- Github CLI adapter lives at packages/github

## Taste

- Complexity belongs at the adapter boundary. Orchestration stays pure, UI stays dumb.
- Inferred types over annotations. any is the enemy.
- Comments describe how a thing is used, and move when the code moves. To be used mostly to describe functions, not to annotate every line of behavior.
- Our users are most of the time developers and people that pay attentions to little details and will notice fps drops, lying spinner, stale labels. No continuously repainting animations; they peg the GPU on high-refresh displays.
- If a rule here fights the task in front of you, say so loudly and get a human sign-off before breaking it.
- All the components used should be from shadcn, from shadcn registry at components.json or a custom built component we approved you to create with base-ui.

## Additional Tips

- Don't verify with browsers or computer use unless the user explicitly agrees or requests it.
- Security is important, but should not be over-indexed on, especially for dev mode/maintainer-only features.
