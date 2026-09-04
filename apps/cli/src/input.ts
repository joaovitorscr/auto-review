const DEFAULT_OUTPUT = "apps/web/public/pr.json";

export function usage(): string {
  return `Usage: auto-review snapshot [number-or-url] [--output path]\n\nFetches a pull request with GitHub CLI and writes a JSON snapshot.\nIf number-or-url is omitted, gh uses the pull request for the current branch.`;
}

export function parseArguments(args: string[]): { target?: string; output: string } {
  const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
  const [command, ...rest] = normalizedArgs;
  if (command !== "snapshot") {
    throw new Error(command ? `Unknown command: ${command}\n\n${usage()}` : usage());
  }

  let target: string | undefined;
  let output = DEFAULT_OUTPUT;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--output" || argument === "-o") {
      const value = rest[index + 1];
      if (!value) throw new Error(`${argument} needs a path`);
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
  return { target, output };
}

export function repositoryName(url: string): string {
  const [, owner, repository] = new URL(url).pathname.split("/");
  if (!owner || !repository) throw new Error(`Could not read repository from PR URL: ${url}`);
  return `${owner}/${repository}`;
}
