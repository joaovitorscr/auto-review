import { spawn } from "node:child_process";

/** Effort defaults to low; Codex ignores it. */
export type ModelRequest = { prompt: string; schema: object; effort?: "low" | "medium" | "high" };
/** Model, turns and usage are reported only when the agent exposes them. */
export type ModelResponse = {
  output: unknown;
  durationMs: number;
  model?: string;
  turns?: number;
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
};
export type ModelProvider = { complete(request: ModelRequest): Promise<ModelResponse> };

/**
 * Runs an agent CLI with the prompt on stdin and resolves with its stdout.
 * Rejects with the abort reason when cancelled, and kills the child on timeout.
 */
export function runAgent(options: {
  name: string;
  executable: string;
  args: string[];
  prompt: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  hint: string;
  cwd?: string;
}) {
  return new Promise<string>((accept, reject) => {
    const child = spawn(options.executable, options.args, {
      stdio: ["pipe", "pipe", "pipe"],
      signal: options.signal,
      cwd: options.cwd,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? 300_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-1500);
    });
    child.stdin.on("error", () => {
      /* The close/error events report early process exits. */
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (options.signal?.aborted) reject(options.signal.reason);
      else reject(new Error(`Could not start ${options.name}: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (options.signal?.aborted) reject(options.signal.reason);
      else if (timedOut)
        reject(new Error(`${options.name} review pass timed out after its time limit.`));
      else if (code !== 0)
        // Claude Code reports failures as JSON on stdout and leaves stderr empty.
        reject(
          new Error(
            `${options.name} exited with code ${code}. ${options.hint}\n${stderr || stdout.slice(-1500)}`,
          ),
        );
      else accept(stdout);
    });
    child.stdin.end(options.prompt);
  });
}
