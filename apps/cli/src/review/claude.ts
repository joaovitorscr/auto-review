import { runAgent } from "./agent.js";
import type { ModelProvider } from "./agent.js";

/**
 * Uses the user's Claude Code login in a fresh headless session per pass.
 * Only Read, Grep and Glob are available, permission prompts are denied, and MCP servers are skipped.
 */
export function claudeProvider(options: {
  checkout: string;
  model?: string;
  executable?: string;
  timeoutMs?: number;
  maxBudgetUsd?: number;
  signal?: AbortSignal;
}): ModelProvider {
  return {
    async complete(request) {
      const started = Date.now();
      const args = [
        "--print",
        "--output-format",
        "json",
        "--json-schema",
        JSON.stringify(request.schema),
        "--tools",
        "Read,Grep,Glob",
        "--permission-mode",
        "dontAsk",
        "--no-session-persistence",
        "--strict-mcp-config",
        "--model",
        options.model ?? "claude-opus-5-5",
        "--effort",
        "low",
        // Caps one pass so a runaway exploration cannot drain the user's plan.
        "--max-budget-usd",
        String(options.maxBudgetUsd ?? 0.5),
      ];
      const stdout = await runAgent({
        name: "Claude Code",
        executable: options.executable ?? "claude",
        args,
        prompt: request.prompt,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        hint: "Check that 'claude' is logged in and your model configuration.",
        cwd: options.checkout,
      });
      let result: {
        is_error?: boolean;
        subtype?: string;
        result?: unknown;
        structured_output?: unknown;
        total_cost_usd?: number;
        usage?: {
          input_tokens?: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
          output_tokens?: number;
        };
        modelUsage?: Record<string, { outputTokens?: number }>;
      };
      try {
        result = JSON.parse(stdout);
      } catch {
        throw new Error("Claude Code did not produce a valid JSON result.");
      }
      if (result.is_error || result.subtype !== "success")
        throw new Error(
          `Claude Code review pass failed (${result.subtype ?? "error"}): ${String(result.result ?? "")}`.trim(),
        );
      if (result.structured_output === undefined)
        throw new Error("Claude Code did not produce a valid JSON review response.");
      // The model that wrote most output tokens did the review; others are helper calls.
      const model = Object.entries(result.modelUsage ?? {}).sort(
        ([, a], [, b]) => (b.outputTokens ?? 0) - (a.outputTokens ?? 0),
      )[0]?.[0];
      return {
        output: result.structured_output,
        durationMs: Date.now() - started,
        model,
        usage: {
          inputTokens:
            result.usage &&
            (result.usage.input_tokens ?? 0) +
              (result.usage.cache_creation_input_tokens ?? 0) +
              (result.usage.cache_read_input_tokens ?? 0),
          outputTokens: result.usage?.output_tokens,
          costUsd: result.total_cost_usd,
        },
      };
    },
  };
}
