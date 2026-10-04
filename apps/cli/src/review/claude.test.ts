import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeProvider } from "./claude.js";

async function withExecutable(
  body: string,
  run: (directory: string, executable: string) => Promise<void>,
) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "auto-review-claude-test-")));
  const executable = join(directory, "fake-claude");
  try {
    await writeFile(executable, `#!/usr/bin/env node\n${body}\n`);
    await chmod(executable, 0o755);
    await run(directory, executable);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const respond = (result: object) => `
const fs = require('node:fs');
let prompt = '';
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  fs.writeFileSync('invocation.json', JSON.stringify({ args: process.argv.slice(2), prompt, cwd: process.cwd() }));
  process.stdout.write(JSON.stringify(${JSON.stringify(result)}));
});`;

describe("Claude Code process adapter", () => {
  it("runs a read-only headless session in the checkout and returns structured output with usage", async () => {
    await withExecutable(
      respond({
        type: "result",
        subtype: "success",
        is_error: false,
        structured_output: { findings: [] },
        total_cost_usd: 0.02,
        num_turns: 3,
        usage: {
          input_tokens: 4,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 6,
          output_tokens: 50,
        },
        modelUsage: { "claude-haiku": { outputTokens: 2 }, "claude-opus": { outputTokens: 50 } },
      }),
      async (directory, executable) => {
        const result = await claudeProvider({
          checkout: directory,
          executable,
          model: "opus",
        }).complete({
          prompt: "Review $(this)",
          schema: { type: "object" },
        });
        expect(result).toMatchObject({
          output: { findings: [] },
          model: "claude-opus",
          turns: 3,
          usage: { inputTokens: 20, outputTokens: 50, costUsd: 0.02 },
        });
        const invocation = JSON.parse(await readFile(join(directory, "invocation.json"), "utf8"));
        expect(invocation.cwd).toBe(directory);
        expect(invocation.prompt).toBe("Review $(this)");
        const args: string[] = invocation.args;
        expect(args[args.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
        expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
        expect(args[args.indexOf("--json-schema") + 1]).toBe('{"type":"object"}');
        expect(args).toEqual(
          expect.arrayContaining([
            "--no-session-persistence",
            "--strict-mcp-config",
            "--model",
            "opus",
          ]),
        );
      },
    );
  });
  it("fails on error results, missing structured output and malformed stdout", async () => {
    const run = (executable: string, checkout: string) =>
      claudeProvider({ checkout, executable }).complete({ prompt: "test", schema: {} });
    await withExecutable(
      respond({ subtype: "error_max_turns", is_error: true, result: "Ran out of turns" }),
      async (directory, executable) => {
        await expect(run(executable, directory)).rejects.toThrow("error_max_turns");
      },
    );
    await withExecutable(
      respond({ subtype: "success", is_error: false }),
      async (directory, executable) => {
        await expect(run(executable, directory)).rejects.toThrow("valid JSON review response");
      },
    );
    await withExecutable("process.stdout.write('not json')", async (directory, executable) => {
      await expect(run(executable, directory)).rejects.toThrow("valid JSON result");
    });
    await withExecutable("process.exit(3)", async (directory, executable) => {
      await expect(run(executable, directory)).rejects.toThrow("exited with code 3");
    });
  });
});
