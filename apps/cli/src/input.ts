import { createHash } from "node:crypto";
import { parseReviewArguments } from "./review/input.js";

const DEFAULT_OUTPUT = "apps/web/public/pr.json";

export function usage(): string {
  return `Usage: auto-review snapshot [number-or-url] [--output path]\n       auto-review index [repository-path] [--output path]\n       auto-review review --base ref [--head ref] [--repo path] [--model id] [--output report.json] [--dry-run]\n\nReview runs Codex against committed JS/TS changes. --dry-run writes context without invoking Codex.\n\nIndex writes a local Git checkout AST as JSON to stdout or --output.\n\nSnapshot fetches a pull request with GitHub CLI and writes a JSON snapshot.\nIf number-or-url is omitted, gh uses the pull request for the current branch.`;
}

export function parseArguments(args: string[]) {
  const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
  const [command, ...rest] = normalizedArgs;
  if (command === "review") return parseReviewArguments(rest);
  if (command !== "snapshot" && command !== "index") {
    throw new Error(command ? `Unknown command: ${command}\n\n${usage()}` : usage());
  }

  let target: string | undefined;
  let output = command === "index" ? "" : DEFAULT_OUTPUT;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--output" || argument === "-o") {
      const value = rest[index + 1];
      if (!value || value.startsWith("-")) throw new Error(`${argument} needs a path`);
      output = value;
      index += 1;
    } else if (argument?.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`);
    } else if (target) {
      throw new Error(`Unexpected argument: ${argument}`);
    } else {
      target = argument;
    }
  }
  return { command, target, output } as const;
}

export function repositoryName(url: string): string {
  const [, owner, repository] = new URL(url).pathname.split("/");
  if (!owner || !repository) throw new Error(`Could not read repository from PR URL: ${url}`);
  return `${owner}/${repository}`;
}

export function avatarUrl(login: string): string {
  return `https://github.com/${encodeURIComponent(login)}.png?size=80`;
}

export function fileDiffUrl(pullRequestUrl: string, path: string): string {
  const anchor = createHash("sha256").update(path).digest("hex");
  return `${pullRequestUrl}/files#diff-${anchor}`;
}
