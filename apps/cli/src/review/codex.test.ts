import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexProvider } from "./codex.js";

async function withExecutable(
  body: string,
  run: (directory: string, executable: string) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "auto-review-process-test-"));
  const executable = join(directory, "fake-codex");
  try {
    await writeFile(
      executable,
      `#!/usr/bin/env node
if (process.argv.includes("mcp")) {
  console.log(JSON.stringify([{ name: "linear", enabled: true }, { name: "off", enabled: false }]));
  process.exit(0);
}
${body}
`,
    );
    await chmod(executable, 0o755);
    await run(directory, executable);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("Codex process adapter", () => {
  it("sends context through stdin, passes a schema, and requests a fresh read-only session", async () => {
    await withExecutable(
      `
const fs = require('node:fs');
const args = process.argv.slice(2);
let prompt = '';
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  const schema = args[args.indexOf('--output-schema') + 1];
  const output = args[args.indexOf('--output-last-message') + 1];
  const cwd = args[args.indexOf('--cd') + 1];
  fs.writeFileSync(cwd + '/invocation.json', JSON.stringify({ args, prompt, schema: JSON.parse(fs.readFileSync(schema, 'utf8')) }));
  fs.writeFileSync(output, JSON.stringify({ findings: [] }));
});`,
      async (directory, executable) => {
        const result = await codexProvider({
          checkout: directory,
          executable,
          model: "configured-test-model",
        }).complete({ prompt: "Review literal `code` and $(text)", schema: { type: "object" } });
        expect(result.output).toEqual({ findings: [] });
        const invocation = JSON.parse(await readFile(join(directory, "invocation.json"), "utf8"));
        expect(invocation.prompt).toBe("Review literal `code` and $(text)");
        expect(invocation.args).toEqual(
          expect.arrayContaining([
            "never",
            "read-only",
            "--ephemeral",
            "--model",
            "configured-test-model",
          ]),
        );
        expect(invocation.args.slice(0, 6)).toEqual([
          "--disable",
          "plugins",
          "--disable",
          "apps",
          "-c",
          "mcp_servers.linear.enabled=false",
        ]);
        expect(invocation.schema).toEqual({ type: "object" });
        await expect(
          readFile(invocation.args[invocation.args.indexOf("--output-schema") + 1]),
        ).rejects.toThrow();
      },
    );
  });
  it("fails on unsuccessful exits and missing structured output", async () => {
    await withExecutable("process.exit(2)", async (directory, executable) => {
      await expect(
        codexProvider({ checkout: directory, executable }).complete({ prompt: "test", schema: {} }),
      ).rejects.toThrow("exited with code 2");
    });
    await withExecutable("process.exit(0)", async (directory, executable) => {
      await expect(
        codexProvider({ checkout: directory, executable }).complete({ prompt: "test", schema: {} }),
      ).rejects.toThrow("valid JSON");
    });
  });
  it("terminates its own child when the pass times out", async () => {
    await withExecutable("setInterval(() => {}, 1000)", async (directory, executable) => {
      await expect(
        codexProvider({ checkout: directory, executable, timeoutMs: 100 }).complete({
          prompt: "test",
          schema: {},
        }),
      ).rejects.toThrow("timed out");
    });
  });
  it("stops its child and reports cancellation when aborted", async () => {
    await withExecutable("setInterval(() => {}, 1000)", async (directory, executable) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error("Review cancelled.")), 100);
      await expect(
        codexProvider({ checkout: directory, executable, signal: controller.signal }).complete({
          prompt: "test",
          schema: {},
        }),
      ).rejects.toThrow("Review cancelled.");
    });
  });
});
