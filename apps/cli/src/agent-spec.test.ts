import { describe, expect, it } from "vitest";
import { parseAgentSpec } from "./agent-spec.js";

describe("eval agent spec", () => {
  it("lets the first detector judge unless a judge is named", () => {
    expect(parseAgentSpec("codex")).toEqual({ detectors: ["codex"], judge: "codex" });
    expect(parseAgentSpec("codex+claude")).toEqual({ detectors: ["codex"], judge: "claude" });
    expect(parseAgentSpec("claude,claude+claude")).toEqual({ detectors: ["claude", "claude"], judge: "claude" });
    expect(parseAgentSpec("codex,claude")).toEqual({ detectors: ["codex", "claude"], judge: "codex" });
  });
  it("rejects unknown names and malformed specs", () => {
    for (const spec of ["gpt", "codex+gpt", "codex,,claude", "codex+claude+codex", "+claude", ""])
      expect(parseAgentSpec(spec)).toBeUndefined();
  });
});
