import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { promisify } from "node:util";
import type { ModelProvider, ModelResponse } from "./agent.js";
import { object } from "./findings.js";
import type { Finding } from "./findings.js";

const exec = promisify(execFile);
const COMMAND_LIMIT_MS = 5 * 60_000;

export const proofSchema = {
  type: "object",
  additionalProperties: false,
  required: ["outcome", "reason", "question", "setupCommand", "bugCommand", "controlCommand", "expectedFailure", "testFiles"],
  properties: {
    outcome: { type: "string", enum: ["reproduced", "refuted", "untested"] },
    reason: { type: "string" },
    question: { type: "string" },
    setupCommand: { type: "string" },
    bugCommand: { type: "string" },
    controlCommand: { type: "string" },
    expectedFailure: { type: "string" },
    testFiles: { type: "array", items: { type: "string" } },
  },
};

export type Verification = {
  verdict: "proven" | "refuted" | "untested";
  reason: string;
  /** A product question for the developer, when the bug's weight depends on how the app is used. */
  question?: string;
  /** The fix agent's acceptance check: `bugCommand` passes once the bug is fixed. */
  test?: {
    files: Array<{ path: string; content: string }>;
    setupCommand: string;
    bugCommand: string;
    controlCommand: string;
    expectedFailure: string;
  };
  fixPatch?: string;
  /** The test as a diff against the reviewed commit; `test.files` holds whole files, which can be huge. */
  testPatch?: string;
  /** `passes` means the PR introduced the bug. `fails` says little: a new feature has no base equivalent. */
  atBase?: "passes" | "fails" | "no result";
  agent: Pick<ModelResponse, "durationMs" | "model" | "turns" | "usage">;
};

// Unlike findings, these may be empty: an untested proof has no commands.
const text = (value: unknown) => {
  if (typeof value !== "string") throw new Error("Invalid text in agent response");
  return value;
};

export function parseProof(value: unknown) {
  const proof = object(value);
  if (proof.outcome !== "reproduced" && proof.outcome !== "refuted" && proof.outcome !== "untested")
    throw new Error("Invalid outcome from the agent");
  if (!Array.isArray(proof.testFiles)) throw new Error("Invalid test files from the agent");
  const testFiles = proof.testFiles.map(text);
  for (const file of testFiles)
    if (isAbsolute(file) || normalize(file).startsWith("..")) throw new Error(`Test file outside the checkout: ${file}`);
  return {
    outcome: proof.outcome,
    reason: text(proof.reason),
    question: text(proof.question),
    setupCommand: text(proof.setupCommand),
    bugCommand: text(proof.bugCommand),
    controlCommand: text(proof.controlCommand),
    expectedFailure: text(proof.expectedFailure),
    testFiles,
  };
}

function proofPrompt(finding: Finding, base: string, head: string) {
  return `You are in a disposable checkout of a pull request's head commit (${head}; its base is ${base}). A reviewer made the claim below. Find out whether it is true by running the code. Do not settle it by reading.

Claim: ${finding.title}
Where: ${finding.file}:${finding.line}
Explanation: ${finding.explanation}
Scenario: ${finding.scenario}
Suggested fix: ${finding.suggestedFix}

Install what you need, then write a test that follows these rules:
- Drive the scenario through the application's real entry points and the project's own test harness. Do not construct private state the application could not reach.
- Put two named cases in it: the bug case, which asserts the correct behaviour and so fails while the bug exists, and a control, a nearby working path that passes now.
- If the bug case fails, make the smallest source change that fixes the bug and leave it in place. It must pass with that change. Do not change test files to make it pass.
- If the bug case passes, the claim is refuted only if the test shows the scenario really ran, for example by also asserting what the code did on the way. A test that passes because it never reached the code proves nothing, so fix the test.
- Do not push, open pull requests, or change anything outside this checkout.

Report:
- outcome: "reproduced" if the bug case failed and your change fixed it, "refuted" if it passed having really run the scenario, otherwise "untested".
- reason: one or two plain sentences on what happens, for someone who does not read code.
- question: a question about the product, not the code, if the bug's weight depends on how the app is used, such as whether a service is public. Otherwise "".
- setupCommand: the command that installs dependencies, safe to run again.
- bugCommand and controlCommand: shell commands from the checkout root that run only that case, without watch mode.
- expectedFailure: a short, single-line piece of the assertion error the bug case prints when it fails. Not the test's name.
- testFiles: every file holding test code, relative to the checkout root, plus every file you added or changed only so the test can run, such as a test runner added to package.json, its lockfile and its config. AutoReview rebuilds the checkout from these files alone. Your source fix must not be in these files.
For "untested", leave the commands empty if you have none. AutoReview reruns everything itself.`;
}

/** Runs a shell command in its own process group, so a timeout also stops the test runner it started. */
function run(command: string, cwd: string, signal?: AbortSignal) {
  return new Promise<{ code: number | null; output: string }>((accept, reject) => {
    const child = spawn("sh", ["-c", command], {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: "true", NO_COLOR: "1" },
    });
    let output = "";
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-200_000);
    };
    const stop = () => {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    };
    const timer = setTimeout(stop, COMMAND_LIMIT_MS);
    signal?.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      if (signal?.aborted) reject(signal.reason);
      // A killed command reports a null code, which every check below treats as no result.
      else accept({ code, output });
    });
  });
}

/** The verdict from AutoReview's own rerun, so a proof never rests on the agent's word. */
export function judgeProof(runs: {
  withFix: { code: number | null; output: string };
  bug: { code: number | null; output: string };
  control: { code: number | null };
  expectedFailure: string;
  fixChanged: boolean;
}) {
  if (!runs.fixChanged) return "no source fix was left in place";
  if (runs.withFix.code !== 0) return "the bug case does not pass with the fix";
  if (runs.bug.code === null || runs.control.code === null) return "a test run timed out, which is no result";
  if (runs.control.code !== 0) return "the control fails without the fix";
  if (runs.bug.code === 0) return "the bug case passes without the fix";
  if (!runs.expectedFailure.trim() || !runs.bug.output.includes(runs.expectedFailure)) return "the bug case fails for a different reason";
  if (runs.withFix.output.includes(runs.expectedFailure)) return "the expected failure also prints with the fix";
  return undefined;
}

async function verifyInCheckout(
  checkout: string,
  finding: Finding,
  report: { base: string; head: string },
  provider: ModelProvider,
  signal?: AbortSignal,
): Promise<Verification> {
  const git = async (...args: string[]) => (await exec("git", ["-C", checkout, ...args], { maxBuffer: 50 * 1024 * 1024 })).stdout;
  const response = await provider.complete({ prompt: proofPrompt(finding, report.base, report.head), schema: proofSchema });
  const proof = parseProof(response.output);
  const agent = { durationMs: response.durationMs, model: response.model, turns: response.turns, usage: response.usage };
  const untested = (reason: string): Verification => ({ verdict: "untested", reason, agent, ...(proof.question && { question: proof.question }) });
  if (proof.outcome === "untested") return untested(proof.reason);
  if (!proof.testFiles.length || !proof.bugCommand) return untested(`The agent reported no test: ${proof.reason}`);

  let files: Array<{ path: string; content: string }>;
  try {
    files = await Promise.all(proof.testFiles.map(async (path) => ({ path, content: await readFile(join(checkout, path), "utf8") })));
  } catch {
    return untested("The agent named a test file that does not exist.");
  }
  const test = {
    files,
    setupCommand: proof.setupCommand,
    bugCommand: proof.bugCommand,
    controlCommand: proof.controlCommand,
    expectedFailure: proof.expectedFailure,
  };
  // Every state is rebuilt from a commit plus the saved test, leaving ignored dependencies in place.
  const restore = async (commit: string) => {
    await git("-c", "core.hooksPath=/dev/null", "checkout", "--force", "--detach", commit);
    await git("clean", "-fdq");
    for (const file of files) {
      await mkdir(dirname(join(checkout, file.path)), { recursive: true });
      await writeFile(join(checkout, file.path), file.content);
    }
  };

  if (proof.outcome === "refuted") {
    await restore(report.head);
    const bug = await run(proof.bugCommand, checkout, signal);
    return bug.code === 0
      ? { verdict: "refuted", reason: proof.reason, test, agent }
      : untested("The agent called this refuted, but its test does not pass at the reviewed commit.");
  }

  const withFix = await run(proof.bugCommand, checkout, signal);
  await git("add", "--all", "--", ".");
  const fixPatch = await git("diff", "--cached", "--binary", report.head, "--", ".", ...files.map((file) => `:(exclude,literal)${file.path}`));
  const testPatch = await git("diff", "--cached", report.head, "--", ...files.map((file) => `:(literal)${file.path}`));
  await restore(report.head);
  const bug = await run(proof.bugCommand, checkout, signal);
  const control = await run(proof.controlCommand || "false", checkout, signal);
  const failed = judgeProof({ withFix, bug, control, expectedFailure: proof.expectedFailure, fixChanged: Boolean(fixPatch.trim()) });
  if (failed) return { ...untested(`The rerun did not hold: ${failed}.`), test, fixPatch };

  await restore(report.base);
  const setup = await run(proof.setupCommand || "true", checkout, signal);
  const atBase = setup.code === 0 ? await run(proof.bugCommand, checkout, signal) : undefined;
  return {
    verdict: "proven",
    reason: proof.reason,
    ...(proof.question && { question: proof.question }),
    test,
    fixPatch,
    testPatch,
    atBase: atBase?.code === 0 ? "passes" : atBase?.code ? "fails" : "no result",
    agent,
  };
}

/**
 * Proves one finding in a throwaway clone with no remote, so the agent cannot reach the source
 * repository. The clone shares the source's objects and writes nothing back to it.
 */
export async function verifyFinding(
  finding: Finding,
  report: { base: string; head: string },
  options: { repository: string; provider: (checkout: string) => ModelProvider; signal?: AbortSignal },
) {
  const temporary = await mkdtemp(join(tmpdir(), "auto-review-verify-"));
  const checkout = join(temporary, "checkout");
  try {
    await exec("git", ["clone", "--quiet", "--shared", "--no-checkout", resolve(options.repository), checkout]);
    await exec("git", ["-C", checkout, "remote", "remove", "origin"]);
    await exec("git", ["-C", checkout, "-c", "core.hooksPath=/dev/null", "checkout", "--quiet", "--detach", report.head]);
    return await verifyInCheckout(checkout, finding, report, options.provider(checkout), options.signal);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export function renderVerification(findings: ReadonlyArray<Finding & { verification?: Verification }>) {
  const checked = findings.filter((finding) => finding.verification);
  const count = (verdict: Verification["verdict"]) => checked.filter((finding) => finding.verification!.verdict === verdict).length;
  const lines = [`# AutoReview verification`, "", `${count("proven")} proven, ${count("refuted")} refuted, ${count("untested")} untested.`, ""];
  for (const finding of checked)
    lines.push(`- ${finding.verification!.verdict}: ${finding.title} (\`${finding.file}:${finding.line}\`). ${finding.verification!.reason}`);
  const questions = checked.flatMap((finding) => finding.verification!.question ?? []);
  if (questions.length) lines.push("", "Questions for you:", ...questions.map((question) => `- ${question}`));
  return `${lines.join("\n")}\n`;
}
