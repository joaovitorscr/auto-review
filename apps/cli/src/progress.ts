#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DATABASE = join(WORKSPACE_ROOT, "evals", "progress.db");
const LABELS = ["correct", "incorrect", "not_introduced", "low_value", "duplicate"];

/**
 * One row per case and agent in an eval output. Findings are every candidate the run produced;
 * reference_hits is the runner's 15-line proximity match, which a label with `reference` confirms.
 * Labels are keyed by finding content, so a replay that reproduces a finding inherits its label.
 */
const SCHEMA = `
create table if not exists runs (
  id integer primary key,
  source text not null,
  position integer not null,
  recorded_at text not null,
  git_commit text,
  case_name text not null,
  split text,
  agent text not null,
  config text,
  detector_only integer,
  replay_of text,
  outcome text,
  passes integer,
  cost_usd real,
  duration_ms integer,
  note text,
  unique (source, position)
);
create table if not exists findings (
  id integer primary key,
  run_id integer not null references runs(id),
  file text not null,
  line integer not null,
  title text not null,
  severity text,
  confidence real,
  posted integer not null,
  verdict text
);
create table if not exists reference_hits (
  run_id integer not null references runs(id),
  comment text not null,
  severity text,
  title text,
  near integer not null,
  primary key (run_id, comment)
);
create table if not exists labels (
  case_name text not null,
  file text not null,
  line integer not null,
  title text not null,
  label text not null,
  reference text,
  note text,
  labeled_at text not null,
  primary key (case_name, file, line, title)
);
`;

export function openProgress() {
  const db = new DatabaseSync(DATABASE);
  db.exec(SCHEMA);
  return db;
}

type Located = { file: string; line: number; title: string; severity?: string; confidence?: number; verdict?: string };
type Saved = {
  case: string;
  split?: string;
  agent: string;
  outcome?: string;
  detectorOnly?: boolean;
  passes?: Array<{ phase: string; candidates?: Located[] }>;
  findings?: Located[];
  deferred?: Located[];
  proposed?: Located[];
  reference?: { comments?: Array<{ file: string; line: number; severity: string; title: string; found: boolean }> };
  costUsd?: number;
  durationMs?: number;
  commit?: string;
  note?: string;
  replay?: string;
};

/** Adds every result in one outputs/eval-*.json file; files already imported are skipped. */
export async function recordOutput(db: DatabaseSync, path: string, notes = new Map<string, { config: string; note?: string }>()) {
  const source = basename(path, ".json");
  if (db.prepare("select 1 from runs where source = ?").get(source)) return 0;
  const results: Saved[] = JSON.parse(await readFile(path, "utf8"));
  const recordedAt = new Date(Number(source.replace("eval-", ""))).toISOString().slice(0, 10);
  const insertRun = db.prepare(
    "insert into runs (source, position, recorded_at, git_commit, case_name, split, agent, config, detector_only, replay_of, outcome, passes, cost_usd, duration_ms, note) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertFinding = db.prepare("insert into findings (run_id, file, line, title, severity, confidence, posted, verdict) values (?, ?, ?, ?, ?, ?, ?, ?)");
  const insertHit = db.prepare("insert into reference_hits (run_id, comment, severity, title, near) values (?, ?, ?, ?, ?)");
  db.exec("begin");
  results.forEach((result, position) => {
    const known = notes.get(`${source}:${result.case}`);
    const { lastInsertRowid: runId } = insertRun.run(
      source, position, recordedAt, result.commit ?? null, result.case, result.split ?? null, result.agent,
      known?.config ?? result.note ?? null, result.detectorOnly ? 1 : 0, result.replay ?? null, result.outcome ?? null,
      result.passes?.filter((pass) => pass.phase === "detector").length ?? null, result.costUsd ?? null, result.durationMs ?? null, known?.note ?? null,
    );
    // Older outputs have no `proposed`; their posted findings are the only candidates recorded.
    const same = (a: Located) => (b: Located) => a.file === b.file && a.line === b.line && a.title === b.title;
    const detailed = [...(result.findings ?? []), ...(result.deferred ?? []), ...(result.passes ?? []).flatMap((pass) => pass.candidates ?? [])];
    for (const candidate of result.proposed ?? result.findings ?? []) {
      const detail = detailed.find(same(candidate));
      const posted = !result.detectorOnly && (result.findings ?? []).some(same(candidate));
      insertFinding.run(runId, candidate.file, candidate.line, candidate.title, detail?.severity ?? null, detail?.confidence ?? null, posted ? 1 : 0, candidate.verdict ?? null);
    }
    for (const comment of result.reference?.comments ?? [])
      insertHit.run(runId, `${comment.file}:${comment.line}`, comment.severity, comment.title, comment.found ? 1 : 0);
  });
  db.exec("commit");
  return results.length;
}

/** Imports outputs/ in order, carrying over the config labels and notes kept in evals/baseline.json. */
async function importAll(db: DatabaseSync) {
  const baseline: { results: Array<{ case: string; source: string; agent: string; note?: string }> } = JSON.parse(
    await readFile(join(WORKSPACE_ROOT, "evals", "baseline.json"), "utf8"),
  );
  const notes = new Map(baseline.results.map((row) => [`${basename(row.source, ".json")}:${row.case}`, { config: row.agent, note: row.note }]));
  const files = (await readdir(join(WORKSPACE_ROOT, "outputs"))).filter((name) => /^eval-\d+\.json$/.test(name)).sort();
  let added = 0;
  for (const name of files) added += await recordOutput(db, join(WORKSPACE_ROOT, "outputs", name), notes);
  console.log(`${added} results imported from ${files.length} outputs.`);
}

type Run = { id: number; recorded_at: string; case_name: string; agent: string; config: string | null; outcome: string | null; passes: number | null; cost_usd: number | null; git_commit: string | null };

function runs(db: DatabaseSync, caseName?: string) {
  const rows = db
    .prepare(
      `select r.*, (select count(*) from findings f where f.run_id = r.id and f.posted) posted,
         (select count(*) from findings f where f.run_id = r.id) candidates,
         (select sum(near) || '/' || count(*) from reference_hits h where h.run_id = r.id) near
       from runs r where r.outcome != 'error' and (? is null or r.case_name = ?) order by r.id`,
    )
    .all(caseName ?? null, caseName ?? null) as Array<Run & { posted: number; candidates: number; near: string | null }>;
  for (const row of rows)
    console.log(
      `#${row.id}\t${row.recorded_at}\t${row.case_name}\t${row.config ?? row.agent}\t${row.candidates} candidates, ${row.posted} posted\tnear ${row.near ?? "-"}\t${row.cost_usd ? `$${row.cost_usd.toFixed(2)}` : "-"}`,
    );
}

/** A run's findings joined with their labels, and the reference comments a label confirms. */
function findingsOf(db: DatabaseSync, run: Run) {
  return db
    .prepare(
      `select f.*, l.label, l.reference from findings f
       left join labels l on l.case_name = ? and l.file = f.file and l.line = f.line and l.title = f.title
       where f.run_id = ? order by f.posted desc, f.id`,
    )
    .all(run.case_name, run.id) as Array<{ id: number; file: string; line: number; title: string; severity: string | null; posted: number; label: string | null; reference: string | null }>;
}

function getRun(db: DatabaseSync, id: string) {
  const run = db.prepare("select * from runs where id = ?").get(Number(id.replace("#", ""))) as Run | undefined;
  if (!run) throw new Error(`No run ${id}.`);
  return run;
}

/** Per-comment found/missed for two runs of one case, then volume, precision and cost. */
function compare(db: DatabaseSync, a: Run, b: Run) {
  if (a.case_name !== b.case_name) throw new Error(`#${a.id} is ${a.case_name}, #${b.id} is ${b.case_name}.`);
  const hits = db.prepare("select * from reference_hits where run_id = ?");
  const comments = (hits.all(b.id) as Array<{ comment: string; severity: string }>).length ? hits.all(b.id) : hits.all(a.id);
  const sides = [a, b].map((run) => {
    const findings = findingsOf(db, run);
    const near = new Map((hits.all(run.id) as Array<{ comment: string; near: number }>).map((hit) => [hit.comment, hit.near]));
    const posted = findings.filter((finding) => finding.posted || !findings.some((other) => other.posted));
    const labeled = posted.filter((finding) => finding.label);
    // ✓ a labeled finding is this comment's bug, ~ only within 15 lines, · neither.
    const mark = (comment: string) => (findings.some((finding) => finding.reference === comment) ? "✓" : near.get(comment) ? "~" : "·");
    return { run, mark, posted: posted.length, labeled: labeled.length, correct: labeled.filter((finding) => finding.label === "correct").length };
  });
  const width = Math.max(...(comments as Array<{ comment: string }>).map((row) => row.comment.length), 10);
  console.log(`${a.case_name}\n  A #${a.id} ${a.recorded_at} ${a.config ?? a.agent}\n  B #${b.id} ${b.recorded_at} ${b.config ?? b.agent}\n`);
  console.log(`${"reference".padEnd(width)}  severity  A  B`);
  for (const { comment, severity } of comments as Array<{ comment: string; severity: string }>) {
    const [left, right] = sides.map((side) => side.mark(comment));
    console.log(`${comment.padEnd(width)}  ${severity.padEnd(8)}  ${left}  ${right}${left === right ? "" : left === "·" || right === "✓" ? "  gained" : "  lost"}`);
  }
  const count = (mark: string) => sides.map((side) => (comments as Array<{ comment: string }>).filter((row) => side.mark(row.comment) === mark).length).join(" → ");
  console.log(`\nconfirmed ✓  ${count("✓")}\nnear only ~  ${count("~")}`);
  console.log(`posted       ${sides.map((side) => side.posted).join(" → ")}`);
  console.log(`labeled      ${sides.map((side) => `${side.labeled}/${side.posted}`).join(" → ")}`);
  console.log(`precision    ${sides.map((side) => (side.labeled ? `${side.correct}/${side.labeled}` : "-")).join(" → ")}`);
  console.log(`passes, cost ${sides.map((side) => `${side.run.passes ?? "-"}, ${side.run.cost_usd ? `$${side.run.cost_usd.toFixed(2)}` : "$0"}`).join(" → ")}`);
}

/** Lists a run's findings with their ids and labels, for `label`. */
function show(db: DatabaseSync, run: Run) {
  console.log(`#${run.id} ${run.case_name} ${run.config ?? run.agent}`);
  for (const finding of findingsOf(db, run))
    console.log(`  ${finding.id}\t${finding.posted ? "posted" : "      "}\t${finding.severity ?? "-"}\t${finding.label ?? "unlabeled"}${finding.reference ? ` (${finding.reference})` : ""}\t${finding.file}:${finding.line}  ${finding.title}`);
}

/** Labels a finding; --ref names the reference comment it is (a file:line suffix is enough). */
function label(db: DatabaseSync, id: string, verdict: string, reference?: string, note?: string) {
  if (!LABELS.includes(verdict)) throw new Error(`Label must be one of ${LABELS.join(", ")}.`);
  const finding = db.prepare("select f.*, r.case_name from findings f join runs r on r.id = f.run_id where f.id = ?").get(Number(id)) as
    | { run_id: number; case_name: string; file: string; line: number; title: string }
    | undefined;
  if (!finding) throw new Error(`No finding ${id}.`);
  let comment: string | null = null;
  if (reference) {
    const matches = (db.prepare("select distinct comment from reference_hits where run_id = ?").all(finding.run_id) as Array<{ comment: string }>)
      .map((row) => row.comment)
      .filter((key) => key === reference || key.endsWith(`/${reference}`));
    if (matches.length !== 1) throw new Error(`--ref ${reference} matches ${matches.length} reference comments of ${finding.case_name}.`);
    comment = matches[0]!;
  }
  db.prepare(
    `insert into labels (case_name, file, line, title, label, reference, note, labeled_at) values (?, ?, ?, ?, ?, ?, ?, ?)
     on conflict do update set label = excluded.label, reference = excluded.reference, note = excluded.note, labeled_at = excluded.labeled_at`,
  ).run(finding.case_name, finding.file, finding.line, finding.title, verdict, comment, note ?? null, new Date().toISOString().slice(0, 10));
  console.log(`${finding.file}:${finding.line} ${verdict}${comment ? ` = ${comment}` : ""}`);
}

/** The commit an eval ran on, marked when the tree had uncommitted changes. */
export function currentCommit() {
  const git = (...args: string[]) => execFileSync("git", ["-C", WORKSPACE_ROOT, ...args], { encoding: "utf8" }).trim();
  return `${git("rev-parse", "--short", "HEAD")}${git("status", "--porcelain", "--untracked-files=no") ? "+dirty" : ""}`;
}

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const flag = (name: string) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args.splice(index, 2)[1];
  };
  const [ref, note] = [flag("--ref"), flag("--note")];
  const [command, ...rest] = args;
  const db = openProgress();
  if (command === "import") await importAll(db);
  else if (command === "runs") runs(db, rest[0]);
  else if (command === "show" && rest[0]) show(db, getRun(db, rest[0]));
  else if (command === "compare" && rest[0] && rest[1]) compare(db, getRun(db, rest[0]), getRun(db, rest[1]));
  else if (command === "label" && rest[0] && rest[1]) label(db, rest[0], rest[1], ref, note);
  else
    throw new Error(
      `Usage: progress import | runs [case] | show <run> | compare <run> <run> | label <finding> <${LABELS.join("|")}> [--ref file:line] [--note text]\nTracks eval runs in evals/progress.db. eval records each run as it finishes; import adds outputs/ files not yet recorded.`,
    );
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((error: unknown) => {
    console.error(`progress: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
