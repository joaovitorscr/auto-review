import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { runAgent } from "./agent.js";
import type { ModelProvider } from "./agent.js";

const exec = promisify(execFile);
// Plugins and apps bring their own MCP servers, so they are disabled outright.
const isolation = ["--disable", "plugins", "--disable", "apps"];

/** Returns `-c` overrides that disable every MCP server enabled in the user's config.toml. */
async function disableMcpServers(executable: string) {
  const { stdout } = await exec(executable, [...isolation, "mcp", "list", "--json"]);
  let servers: Array<{ name: string; enabled: boolean }>;
  try {
    servers = JSON.parse(stdout);
  } catch {
    throw new Error("Could not list Codex MCP servers to disable them.");
  }
  return servers
    .filter((server) => server.enabled)
    .flatMap((server) => {
      // Codex's -c parser keeps quotes as part of the key, so only bare TOML keys can be disabled.
      if (!/^[\w-]+$/.test(server.name))
        throw new Error(
          `Cannot disable Codex MCP server "${server.name}"; rename it to letters, digits, _ or -.`,
        );
      return ["-c", `mcp_servers.${server.name}.enabled=false`];
    });
}

/**
 * Uses the user's Codex login and model configuration in a fresh read-only session per pass.
 * Plugins, apps and MCP servers are disabled so the review cannot reach external services.
 */
export function codexProvider(options: {
  checkout: string;
  model?: string;
  // Reasoning effort for every pass; low unless an eval asks for more.
  effort?: "low" | "medium" | "high" | "xhigh";
  executable?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): ModelProvider {
  const executable = options.executable ?? "codex";
  let overrides: Promise<string[]> | undefined;
  return {
    name: "codex",
    async complete(request) {
      overrides ??= disableMcpServers(executable);
      const mcp = await overrides;
      const directory = await mkdtemp(join(tmpdir(), "auto-review-codex-"));
      const schema = join(directory, "schema.json");
      const output = join(directory, "result.json");
      const started = Date.now();
      try {
        await writeFile(schema, JSON.stringify(request.schema));
        const args = [
          ...isolation,
          ...mcp,
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
        args.push("--model", options.model ?? "gpt-6-astra", "-c", `model_reasoning_effort=${options.effort ?? "low"}`);
        args.push("-");
        await runAgent({
          name: "Codex",
          executable,
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
