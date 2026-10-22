import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
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
// Schema and migration files have no AST here but decide what the code's inputs reach; they are reviewed as text.
const textReviewed = /\.(sql|prisma|graphql|gql)$/i;
const git = async (root: string, args: string[], env?: NodeJS.ProcessEnv) =>
  (await exec("git", ["-C", root, ...args], { maxBuffer: 20 * 1024 * 1024, env: env && { ...process.env, ...env } })).stdout;

/**
 * Commits staged, unstaged and untracked (not ignored) files on top of HEAD through a copy of the
 * index, so the caller's index, branch and files stay untouched. Returns undefined for a clean tree.
 */
async function snapshotWorkingTree(root: string, temporary: string) {
  if (!(await git(root, ["--no-optional-locks", "status", "--porcelain", "--untracked-files=all"])).trim()) return undefined;
  const index = join(temporary, "index");
  // Copying the real index keeps its stat cache, so `add -A` only rehashes files that changed.
  await copyFile(resolve(root, (await git(root, ["rev-parse", "--git-path", "index"])).trim()), index).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
  const env = {
    GIT_INDEX_FILE: index,
    GIT_AUTHOR_NAME: "AutoReview",
    GIT_AUTHOR_EMAIL: "auto-review@localhost",
    GIT_COMMITTER_NAME: "AutoReview",
    GIT_COMMITTER_EMAIL: "auto-review@localhost",
  };
  await git(root, ["add", "-A", "--", "."], env);
  const tree = (await git(root, ["write-tree"], env)).trim();
  return (await git(root, ["commit-tree", tree, "-p", "HEAD", "-m", "AutoReview working-tree snapshot"], env)).trim();
}

/**
 * Builds context and runs the consumer against the same immutable head checkout. Without `head`,
 * a dirty working tree is reviewed as a snapshot commit on top of HEAD.
 */
export async function withReviewContext<T>(
  options: { repository: string; base: string; head?: string; signal?: AbortSignal },
  consume: (context: ReviewContext, checkout: string, sources: { before: ReadonlyMap<string, string>; after: ReadonlyMap<string, string> }) => Promise<T>,
) {
  const root = (await git(resolve(options.repository), ["rev-parse", "--show-toplevel"])).trim();
  const resolveCommit = async (ref: string) =>
    (await git(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim();
  const temporary = await mkdtemp(join(tmpdir(), "auto-review-"));
  const checkout = join(temporary, "head");
  let added = false;
  try {
    const snapshot = options.head === undefined ? await snapshotWorkingTree(root, temporary) : undefined;
    const head = snapshot ?? (await resolveCommit(options.head ?? "HEAD"));
    const base = (await git(root, ["merge-base", await resolveCommit(options.base), head])).trim();
    const changed = (
      await git(root, ["diff", "--no-renames", "--name-status", "-z", base, head, "--"])
    ).split("\0");
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
    const focus = [];
    for (let position = 0; position < changed.length - 1; position += 2)
      if (changed[position] !== "D") focus.push(changed[position + 1]!);
    const index = await indexRepository(checkout, { dependencyRoot: root, focus });
    const after = new Map<string, string>();
    for (const file of index.files) after.set(file, await readFile(join(checkout, file), "utf8"));
    const before = new Map<string, string>();
    const changes: Change[] = [];
    const skipped: string[] = [];
    const ignored: string[] = [];
    for (let position = 0; position < changed.length - 1; position += 2) {
      const status = changed[position]!;
      const file = changed[position + 1]!;
      if (textReviewed.test(file) && status !== "D" && !after.has(file))
        after.set(file, await readFile(join(checkout, file), "utf8").catch(() => ""));
      if (!(isIndexablePath(file) || textReviewed.test(file)) || (status !== "D" && !after.has(file))) {
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
        workingTreeSnapshot: snapshot !== undefined,
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
      { before, after },
    );
  } finally {
    if (added) await git(root, ["worktree", "remove", "--force", checkout]);
    await rm(temporary, { recursive: true, force: true });
  }
}
