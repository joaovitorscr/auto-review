import { describe, expect, it } from "vitest";
import { checkTone } from "./checks";

describe("checkTone", () => {
  it.each(["SUCCESS", "NEUTRAL", "SKIPPED"])("marks %s as successful", (state) => {
    expect(checkTone(state)).toBe("success");
  });

  it.each(["PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED"])("marks %s as pending", (state) => {
    expect(checkTone(state)).toBe("pending");
  });

  it("treats failed and unknown states as failures", () => {
    expect(checkTone("FAILURE")).toBe("failure");
    expect(checkTone("UNKNOWN")).toBe("failure");
  });
});
