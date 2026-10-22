import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const INVOKED_FROM = process.env.INIT_CWD ?? process.cwd();
const USAGE =
  "Usage: mine owner/repo --repo local-clone (--pr number... | --into branch [--limit N])\n" +
  "Writes one eval case per merged pull request Macroscope commented on, into corpus/cases/<repo>-<number>/.\n" +
  "The case reviews the commit Macroscope first commented on, against its merge base with the pull request's base branch.\n" +
  "Check-run agent comments are skipped; each reference comment records whether Macroscope later marked it resolved.";

type ReviewComment = {
  user: { login: string };
  in_reply_to_id?: number;
  body: string;
  path: string;
  line: number | null;
  original_line: number | null;
  original_commit_id: string;
  created_at: string;
};

const gh = async (args: string[]) => (await exec("gh", args, { maxBuffer: 100 * 1024 * 1024 })).stdout;
const git = async (root: string, args: string[]) => (await exec("git", ["-C", root, ...args], { maxBuffer: 100 * 1024 * 1024 })).stdout.trim();

/** Macroscope's own correctness comments, in posting order, with the outcome it recorded on later pushes. */
export function macroscopeComments(comments: ReviewComment[]) {
  return comments
    .filter((comment) => comment.user.login.startsWith("macroscopeapp") && !comment.in_reply_to_id && !comment.body.includes('"kind":"check_run"'))
    .filter((comment) => comment.original_line !== null)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((comment) => {
      const [header = "", ...rest] = comment.body.split("\n");
      const text = rest.join(" ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      return {
        commit: comment.original_commit_id,
        file: comment.path,
        line: comment.original_line!,
        severity: /\*\*(Critical|High|Medium|Low)\*\*/.exec(header)?.[1] ?? "Medium",
        title: text.slice(0, 160),
        // "Resolved in" and "No longer relevant" are Macroscope's notes after a later push changed the code.
        status: comment.body.includes("✅ Resolved in") ? "resolved" : comment.body.includes("No longer relevant as of") ? "no_longer_relevant" : "open",
      };
    });
}

async function main() {
  const args = process.argv.slice(2).filter((argument) => argument !== "--");
  const [repository, ...rest] = args;
  let clone = "";
  let into = "";
  let limit = 50;
  const numbers: number[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const option = rest[index];
    if (option === "--repo") clone = rest[++index] ?? "";
    else if (option === "--into") into = rest[++index] ?? "";
    else if (option === "--limit") limit = Number(rest[++index]);
    else if (option === "--pr") while (/^\d+$/.test(rest[index + 1] ?? "")) numbers.push(Number(rest[++index]));
    else throw new Error(`Unknown option: ${option}\n\n${USAGE}`);
  }
  if (!repository?.includes("/") || !clone || (!into && !numbers.length)) throw new Error(USAGE);
  const root = resolve(INVOKED_FROM, clone);
  if (into)
    numbers.push(
      ...(JSON.parse(await gh(["pr", "list", "-R", repository, "--state", "merged", "--base", into, "--limit", String(limit), "--json", "number"])) as Array<{ number: number }>).map((pr) => pr.number),
    );
  for (const number of numbers) {
    const name = `${repository.split("/")[1]}-${number}`;
    try {
      const pr = JSON.parse(await gh(["api", `repos/${repository}/pulls/${number}`])) as { base: { sha: string }; html_url: string };
      const pages = JSON.parse(await gh(["api", "--paginate", "--slurp", `repos/${repository}/pulls/${number}/comments`])) as ReviewComment[][];
      const comments = macroscopeComments(pages.flat());
      if (!comments.length) {
        console.error(`${name}: no Macroscope correctness comments, skipped`);
        continue;
      }
      // The first review covers the whole change; later pushes are re-reviews of partial fixes.
      const head = comments[0]!.commit;
      const reference = comments.filter((comment) => comment.commit === head);
      // The base branch may be gone; the base commit GitHub recorded on the pull request is not.
      for (const commit of [pr.base.sha, head])
        await git(root, ["cat-file", "-e", `${commit}^{commit}`]).catch(() => git(root, ["fetch", "-q", "origin", commit]));
      const base = await git(root, ["merge-base", pr.base.sha, head]);
      const label = {
        split: "holdout",
        kind: "regression",
        source: { repository: relative(WORKSPACE_ROOT, root), base: base.slice(0, 12), head: head.slice(0, 12) },
        locations: reference.map((comment) => ({ file: comment.file, lines: [Math.max(1, comment.line - 3), comment.line + 3] })),
        note: `Mined from Macroscope's first review of ${pr.html_url}. Status is what Macroscope recorded after later pushes: resolved and no_longer_relevant mean the code there changed, open means it was merged unchanged.`,
        reference: { reviewer: "Macroscope", comments: reference.map(({ commit: _commit, ...comment }) => comment) },
      };
      const directory = join(WORKSPACE_ROOT, "corpus", "cases", name);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "case.json"), `${JSON.stringify(label, null, 2)}\n`, "utf8");
      console.error(`${name}: ${reference.length} comment(s) at ${head.slice(0, 12)} (${reference.filter((comment) => comment.status !== "open").length} acted on)`);
    } catch (error) {
      console.error(`${name}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
