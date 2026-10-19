import { describe, expect, it } from "vitest";
import { parseAgentSpec } from "./agent-spec.js";

describe("eval agent spec", () => {
  it("runs no judge unless one is named", () => {
    expect(parseAgentSpec("codex")).toEqual({ detectors: ["codex"], judge: undefined });
    expect(parseAgentSpec("codex+claude")).toEqual({ detectors: ["codex"], judge: "claude" });
    expect(parseAgentSpec("claude,claude+claude")).toEqual({ detectors: ["claude", "claude"], judge: "claude" });
    expect(parseAgentSpec("codex,claude")).toEqual({ detectors: ["codex", "claude"], judge: undefined });
  });
  it("rejects unknown names and malformed specs", () => {
    for (const spec of ["gpt", "codex+gpt", "codex,,claude", "codex+claude+codex", "+claude", ""])
      expect(parseAgentSpec(spec)).toBeUndefined();
  });
});
