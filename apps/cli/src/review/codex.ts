import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "./agent.js";
import type { ModelProvider } from "./agent.js";

/** Uses the user's Codex login and model configuration in a fresh read-only session per pass. */
export function codexProvider(options: {
  checkout: string;
  model?: string;
  executable?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): ModelProvider {
  return {
    async complete(request) {
      const directory = await mkdtemp(join(tmpdir(), "auto-review-codex-"));
      const schema = join(directory, "schema.json");
      const output = join(directory, "result.json");
      const started = Date.now();
      try {
        await writeFile(schema, JSON.stringify(request.schema));
        const args = [
          "--ask-for-approval",
          "never",
          "exec",
          "--sandbox",
          "read-only",
          "--ephemeral",
          "--color",
          "never",
          "--cd",
          options.checkout,
          "--output-schema",
          schema,
          "--output-last-message",
          output,
        ];
        if (options.model) args.push("--model", options.model);
        args.push("-");
        await runAgent({
          name: "Codex",
          executable: options.executable ?? "codex",
          args,
          prompt: request.prompt,
          timeoutMs: options.timeoutMs,
          signal: options.signal,
          hint: "Check 'codex login status' and your model configuration.",
        });
        let result: unknown;
        try {
          result = JSON.parse(await readFile(output, "utf8"));
        } catch {
          throw new Error("Codex did not produce a valid JSON review response.");
        }
        return { output: result, durationMs: Date.now() - started };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
