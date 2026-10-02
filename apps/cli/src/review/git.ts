import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { indexRepository, isIndexablePath } from "../repository-index.js";
import { packContext, parseHunks, reviewLines } from "./context.js";
import type { Change, ReviewContext } from "./context.js";

const exec = promisify(execFile);
// Docs, lockfiles, images and ignore files cannot change runtime behavior, so they do not make a review partial.
const nonCode =
  /(^|\/)(LICENSE|CODEOWNERS|\.gitignore|\.gitattributes|\.DS_Store|[^/]+\.(md|mdx|txt|lock|png|jpe?g|gif|svg|ico|webp)|pnpm-lock\.yaml|package-lock\.json)$/i;
const git = async (root: string, args: string[]) =>
  (await exec("git", ["-C", root, ...args], { maxBuffer: 20 * 1024 * 1024 })).stdout;

/** Builds context and runs the consumer against the same immutable head checkout. */
export async function withReviewContext<T>(
  options: { repository: string; base: string; head: string; signal?: AbortSignal },
  consume: (context: ReviewContext, checkout: string) => Promise<T>,
) {
  const root = (await git(resolve(options.repository), ["rev-parse", "--show-toplevel"])).trim();
  const resolveCommit = async (ref: string) =>
    (await git(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim();
  const head = await resolveCommit(options.head);
  const base = (await git(root, ["merge-base", await resolveCommit(options.base), head])).trim();
  const changed = (
    await git(root, ["diff", "--no-renames", "--name-status", "-z", base, head, "--"])
  ).split("\0");
  const temporary = await mkdtemp(join(tmpdir(), "auto-review-"));
  const checkout = join(temporary, "head");
  let added = false;
  try {
    await git(root, [
      "-c",
      "core.hooksPath=/dev/null",
      "worktree",
      "add",
      "--detach",
      checkout,
      head,
    ]);
    added = true;
    const index = await indexRepository(checkout, { dependencyRoot: root });
    const after = new Map<string, string>();
    for (const file of index.files) after.set(file, await readFile(join(checkout, file), "utf8"));
    const before = new Map<string, string>();
    const changes: Change[] = [];
    const skipped: string[] = [];
    const ignored: string[] = [];
    for (let position = 0; position < changed.length - 1; position += 2) {
      const status = changed[position]!;
      const file = changed[position + 1]!;
      if (!isIndexablePath(file) || (status !== "D" && !after.has(file))) {
        (nonCode.test(file) ? ignored : skipped).push(file);
        continue;
      }
      if (status !== "A") before.set(file, await git(root, ["show", `${base}:${file}`]));
      const patch = await git(root, [
        "--literal-pathspecs",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--unified=3",
        base,
        head,
        "--",
        file,
      ]);
      const source = after.get(file);
      const lineCount =
        source === undefined || source === ""
          ? 0
          : source.split("\n").length - (source.endsWith("\n") ? 1 : 0);
      changes.push({
        file,
        status,
        patch,
        hunks: parseHunks(patch),
        reviewLines: reviewLines(patch, lineCount),
      });
    }
    const instructionPaths = new Set(["AGENTS.md"]);
    for (const change of changes) {
      let directory = dirname(change.file);
      while (directory !== ".") {
        instructionPaths.add(`${directory}/AGENTS.md`);
        directory = dirname(directory);
      }
    }
    const instructions: Array<{ file: string; text: string }> = [];
    for (const file of [...instructionPaths].sort()) {
      try {
        instructions.push({ file, text: await readFile(join(checkout, file), "utf8") });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    options.signal?.throwIfAborted();
    return await consume(
      packContext({
        base,
        head,
        changes,
        index,
        before,
        after,
        instructions,
        skipped,
        ignored,
        configErrors: index.configErrors,
      }),
      checkout,
    );
  } finally {
    if (added) await git(root, ["worktree", "remove", "--force", checkout]);
    await rm(temporary, { recursive: true, force: true });
  }
}
