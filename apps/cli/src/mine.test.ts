import { describe, expect, it } from "vitest";
import { macroscopeComments } from "./mine.js";

const comment = (body: string, overrides: object = {}) => ({
  user: { login: "macroscopeapp[bot]" },
  body,
  path: "src/ws.ts",
  line: 10,
  original_line: 12,
  original_commit_id: "abc",
  created_at: "2026-10-01T00:00:00Z",
  ...overrides,
});

describe("macroscopeComments", () => {
  it("keeps Macroscope's correctness comments with severity, title and outcome", () => {
    const [first, second, third, fourth] = macroscopeComments([
      comment("🟡 **Medium** `src/ws.ts:12`\n\nFetching the projection first creates a race.\n\n✅ Resolved in 7fcc993"),
      comment("🟠 **High** `src/ws.ts:40`\n\nThe handler leaks.\n\nNo longer relevant as of 1234567", { original_line: 40 }),
      comment("🟢 **Low** `src/ws.ts:50`\n\n<details>Minor.</details>", { original_line: 50 }),
      comment("<!-- MURMUR_IGNORE -->\n🔴 **Critical**\n\nhttps://github.com/o/r/blob/abc/src/ws.ts#L60\n\nTokens leak to the log.", { original_line: 60 }),
    ]);
    expect(first).toEqual({ commit: "abc", file: "src/ws.ts", line: 12, severity: "Medium", title: expect.stringContaining("creates a race"), status: "resolved" });
    expect(second).toMatchObject({ severity: "High", status: "no_longer_relevant" });
    expect(third).toMatchObject({ severity: "Low", status: "open", title: "Minor." });
    expect(fourth).toMatchObject({ severity: "Critical", title: "Tokens leak to the log." });
  });

  it("skips replies, other authors, check-run agents and comments without a line", () => {
    expect(
      macroscopeComments([
        comment("reply", { in_reply_to_id: 1 }),
        comment("**High** bug", { user: { login: "cursor[bot]" } }),
        comment('**High** rule <!-- macroscope-meta: {"kind":"check_run","config":".macroscope/check-run-agents/ui.md"} -->'),
        comment("**High** file comment", { original_line: null }),
      ]),
    ).toEqual([]);
  });
});
