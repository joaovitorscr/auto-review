import { describe, expect, it } from "vitest";
import { avatarUrl, fileDiffUrl, parseArguments, repositoryName } from "./input.js";

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

describe("GitHub links", () => {
  it("builds a public avatar link from the author login", () => {
    expect(avatarUrl("joaovitorscr")).toBe("https://github.com/joaovitorscr.png?size=80");
  });

  it("links to the matching file in the GitHub diff", () => {
    expect(fileDiffUrl("https://github.com/example/repo/pull/38", "src/index.ts")).toBe(
      "https://github.com/example/repo/pull/38/files#diff-a2a171449d862fe29692ce031981047d7ab755ae7f84c707aef80701b3ea0c80",
    );
  });
});
