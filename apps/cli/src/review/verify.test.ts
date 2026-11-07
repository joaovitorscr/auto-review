import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModelProvider } from "./agent.js";
import type { Finding } from "./findings.js";
import { judgeProof, parseProof, renderVerification, verifyFinding } from "./verify.js";

const exec = promisify(execFile);
const finding = { title: "add subtracts", file: "add.js", line: 1 } as Finding;
const test = 'const { add } = require("./add.js");\nif (add(0, 0) !== 0) throw new Error("zero broke");\nif (process.argv[2] === "bug" && add(2, 1) !== 3) throw new Error("expected 3");\n';
const fixed = "exports.add = (a, b) => a + b;\n";
const proof = {
  outcome: "reproduced",
  reason: "Adding subtracts.",
  question: "",
  forced: "",
  setupCommand: "true",
  bugCommand: "node add.test.js bug",
  controlCommand: "node add.test.js",
  expectedFailure: "expected 3",
  testFiles: ["add.test.js"],
};

describe("verifyFinding", () => {
  let repository: string;
  let report: { base: string; head: string };
  const git = async (...args: string[]) => (await exec("git", ["-C", repository, ...args])).stdout.trim();

  beforeAll(async () => {
    repository = await mkdtemp(join(tmpdir(), "auto-review-verify-test-"));
    await git("init", "--quiet");
    await git("config", "user.email", "test@localhost");
    await git("config", "user.name", "Test");
    await writeFile(join(repository, "add.js"), fixed);
    await git("add", ".");
    await git("commit", "--quiet", "--no-gpg-sign", "-m", "base");
    const base = await git("rev-parse", "HEAD");
    await writeFile(join(repository, "add.js"), "exports.add = (a, b) => a - b;\n");
    await git("commit", "--quiet", "--no-gpg-sign", "-am", "head");
    report = { base, head: await git("rev-parse", "HEAD") };
  });
  afterAll(() => rm(repository, { recursive: true, force: true }));

  // Stands in for the agent: changes the checkout as `edit` says and answers with `output`.
  const verify = (output: object, edit: (checkout: string) => Promise<void>) =>
    verifyFinding(finding, report, {
      repository,
      provider: (checkout): ModelProvider => ({
        async complete() {
          await edit(checkout);
          return { output, durationMs: 1 };
        },
      }),
    });
  const addTest = (checkout: string) => writeFile(join(checkout, "add.test.js"), test);

  it("proves a bug the rerun fails on and the fix clears, and keeps the test", async () => {
    const result = await verify(proof, async (checkout) => {
      await addTest(checkout);
      await writeFile(join(checkout, "add.js"), fixed);
    });
    expect(result).toMatchObject({ verdict: "proven", atBase: "passes", test: { files: [{ path: "add.test.js", content: test }] } });
    expect(result.fixPatch).toContain("a + b");
    expect(result.fixPatch).not.toContain("expected 3");
    expect(result.testPatch).toContain("+if (add(0, 0)");
    expect(result.testPatch).not.toContain("a + b");
  });

  it("keeps the conditions a proof had to force", async () => {
    const result = await verify({ ...proof, forced: "A one-second time limit." }, async (checkout) => {
      await addTest(checkout);
      await writeFile(join(checkout, "add.js"), fixed);
    });
    expect(result).toMatchObject({ verdict: "proven", forced: "A one-second time limit." });
  });

  it("reports a documented choice as intended without a test", async () => {
    const result = await verify({ ...proof, outcome: "intended", testFiles: [], bugCommand: "" }, async () => {});
    expect(result).toMatchObject({ verdict: "intended", reason: "Adding subtracts." });
  });

  it("does not take the agent's word for a bug that does not fail", async () => {
    const passing = 'if (process.argv[2] === "never") throw new Error("expected 3");\n';
    const result = await verify(proof, async (checkout) => {
      await writeFile(join(checkout, "add.test.js"), passing);
      await writeFile(join(checkout, "add.js"), fixed);
    });
    expect(result).toMatchObject({ verdict: "untested", reason: "The rerun did not hold: the bug case passes without the fix." });
  });

  it("does not take the agent's word for a refutation", async () => {
    const result = await verify({ ...proof, outcome: "refuted" }, addTest);
    expect(result.verdict).toBe("untested");
    expect(result.reason).toContain("does not pass");
  });

  it("accepts a refutation whose test passes at the reviewed commit", async () => {
    const result = await verify({ ...proof, outcome: "refuted", bugCommand: "node add.test.js" }, addTest);
    expect(result.verdict).toBe("refuted");
  });

  it("leaves the source repository untouched", async () => {
    expect(await git("status", "--porcelain")).toBe("");
    expect(await readFile(join(repository, "add.js"), "utf8")).toContain("a - b");
  });

  it("renders the score and the product questions", () => {
    const text = renderVerification([
      { ...finding, verification: { verdict: "proven", reason: "It breaks.", question: "Is this service public?", agent: { durationMs: 1 } } },
      finding,
    ]);
    expect(text).toContain("1 proven, 0 refuted, 0 intended, 0 untested.");
    expect(text).toContain("- Is this service public?");
  });
});

describe("judgeProof", () => {
  const passed = { code: 0, output: "" };
  const runs = { withFix: passed, bug: { code: 1, output: "Error: expected 3" }, control: passed, expectedFailure: "expected 3", fixChanged: true };

  it("accepts only the full gate", () => {
    expect(judgeProof(runs)).toBeUndefined();
    expect(judgeProof({ ...runs, fixChanged: false })).toContain("no source fix");
    expect(judgeProof({ ...runs, withFix: { code: 1, output: "" } })).toContain("does not pass with the fix");
    expect(judgeProof({ ...runs, control: { code: 1 } })).toContain("control fails");
    expect(judgeProof({ ...runs, bug: { code: 1, output: "Cannot find module" } })).toContain("different reason");
    expect(judgeProof({ ...runs, withFix: { code: 0, output: "expected 3" } })).toContain("also prints");
  });

  it("treats a killed run as no result, never as a failure", () => {
    expect(judgeProof({ ...runs, bug: { code: null, output: "expected 3" } })).toContain("no result");
  });
});

describe("parseProof", () => {
  it("rejects test paths outside the checkout", () => {
    expect(() => parseProof({ ...proof, testFiles: ["../outside.js"] })).toThrow("outside the checkout");
    expect(() => parseProof({ ...proof, testFiles: ["/etc/passwd"] })).toThrow("outside the checkout");
  });
});
