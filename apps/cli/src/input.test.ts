import { describe, expect, it } from "vitest";
import { parseArguments, repositoryName } from "./input.js";

describe("parseArguments", () => {
  it("accepts arguments forwarded directly by Vite+", () => {
    expect(parseArguments(["snapshot", "https://github.com/example/repo/pull/38"])).toEqual({
      target: "https://github.com/example/repo/pull/38",
      output: "apps/web/public/pr.json",
    });
  });

  it("tolerates a package-runner separator", () => {
    expect(parseArguments(["--", "snapshot", "38"])).toEqual({
      target: "38",
      output: "apps/web/public/pr.json",
    });
  });
});

describe("repositoryName", () => {
  it("reads the owner and repository from a pull request URL", () => {
    expect(repositoryName("https://github.com/othos-io/othos-telemetry/pull/38")).toBe(
      "othos-io/othos-telemetry",
    );
  });
});
