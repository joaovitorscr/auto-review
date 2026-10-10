const agentNames = ["codex", "claude"] as const;
export type AgentName = (typeof agentNames)[number];

const isAgent = (name: string): name is AgentName => (agentNames as readonly string[]).includes(name);

/**
 * Parses an eval `--agent` spec `detectors[+judge]`, e.g. `codex`, `codex+claude` or `codex,claude+claude`.
 * Detectors may repeat; the first one judges when `+judge` is omitted. Returns undefined for unknown names.
 */
export function parseAgentSpec(spec: string) {
  const [list, judge, ...rest] = spec.split("+");
  const detectors = list!.split(",");
  const chosen = judge ?? detectors[0]!;
  if (rest.length || !detectors.every(isAgent) || !isAgent(chosen)) return undefined;
  return { detectors, judge: chosen };
}
