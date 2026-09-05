import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ModelRequest = { prompt: string; schema: object };
export type ModelProvider = {
  complete(request: ModelRequest): Promise<{ output: unknown; durationMs: number }>;
};

/** Uses the user's Codex login and model configuration in a fresh read-only session per pass. */
export function codexProvider(options: {
  checkout: string;
  model?: string;
  executable?: string;
  timeoutMs?: number;
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
        await new Promise<void>((accept, reject) => {
          const child = spawn(options.executable ?? "codex", args, {
            stdio: ["pipe", "ignore", "pipe"],
          });
          let stderr = "";
          let timedOut = false;
          const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, options.timeoutMs ?? 300_000);
          child.stderr.on("data", (chunk: Buffer) => {
            stderr = (stderr + chunk.toString()).slice(-4000);
          });
          child.stdin.on("error", () => {
            /* The close/error events report early process exits. */
          });
          child.on("error", (error) => {
            clearTimeout(timer);
            reject(new Error(`Could not start Codex: ${error.message}`));
          });
          child.on("close", (code) => {
            clearTimeout(timer);
            if (timedOut) reject(new Error("Codex review pass timed out after its time limit."));
            else if (code !== 0)
              reject(
                new Error(
                  `Codex exited with code ${code}. Check 'codex login status' and your model configuration.\n${stderr}`,
                ),
              );
            else accept();
          });
          child.stdin.end(request.prompt);
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
