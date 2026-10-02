export function parseReviewArguments(args: string[]) {
  let base = "";
  let head = "HEAD";
  let repository = ".";
  let agent: "codex" | "claude" = "codex";
  let model: string | undefined;
  let output = "";
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (
      !["--base", "--head", "--repo", "--agent", "--model", "--output", "-o"].includes(option ?? "")
    )
      throw new Error(`Unknown review option: ${option}`);
    const value = args[++index];
    if (!value || value.startsWith("-")) throw new Error(`${option} needs a value`);
    switch (option) {
      case "--base":
        base = value;
        break;
      case "--head":
        head = value;
        break;
      case "--repo":
        repository = value;
        break;
      case "--agent":
        if (value !== "codex" && value !== "claude")
          throw new Error(`--agent must be codex or claude, not ${value}`);
        agent = value;
        break;
      case "--model":
        model = value;
        break;
      default:
        output = value;
    }
  }
  if (!base)
    throw new Error(
      "review requires --base <branch-or-commit>. It reviews committed changes from the merge base to --head (default HEAD), excluding local edits.",
    );
  return { command: "review" as const, base, head, repository, agent, model, output, dryRun };
}
