import { describe, expect, it } from "vitest";
import { avatarUrl, fileDiffUrl, parseArguments, repositoryName } from "./input.js";

describe("parseArguments", () => {
  it("accepts arguments forwarded directly by Vite+", () => {
    expect(parseArguments(["snapshot", "https://github.com/example/repo/pull/38"])).toEqual({
      command: "snapshot",
      target: "https://github.com/example/repo/pull/38",
      output: "apps/web/public/pr.json",
    });
  });

  it("tolerates a package-runner separator", () => {
    expect(parseArguments(["--", "snapshot", "38"])).toEqual({
      command: "snapshot",
      target: "38",
      output: "apps/web/public/pr.json",
    });
  });
});

describe("post arguments", () => {
  it("reads the report, an optional pull request and the minimum severity", () => {
    expect(parseArguments(["post", "report.json"])).toEqual({ command: "post", report: "report.json", target: undefined, minimum: "low", dryRun: false });
    expect(parseArguments(["post", "report.json", "12", "--min", "medium", "--dry-run"])).toMatchObject({ target: "12", minimum: "medium", dryRun: true });
  });

  it("rejects a missing report and unknown severities", () => {
    expect(() => parseArguments(["post"])).toThrow("saved review report");
    expect(() => parseArguments(["post", "report.json", "--min", "trivial"])).toThrow("--min");
  });
});

describe("verify arguments", () => {
  it("reads the report, repository and options", () => {
    expect(parseArguments(["verify", "report.json", "--repo", "/repo"])).toEqual({ command: "verify", report: "report.json", repository: "/repo", minimum: "low", model: undefined, output: "" });
    expect(parseArguments(["verify", "report.json", "--repo", "/repo", "--min", "medium", "-o", "out.json"])).toMatchObject({ minimum: "medium", output: "out.json" });
  });

  it("needs a report and the repository it reviewed", () => {
    expect(() => parseArguments(["verify"])).toThrow("saved review report");
    expect(() => parseArguments(["verify", "report.json"])).toThrow("--repo");
  });
});

describe("repositoryName", () => {
  it("reads the owner and repository from a pull request URL", () => {
    expect(repositoryName("https://github.com/acme-io/acme-telemetry/pull/38")).toBe(
      "acme-io/acme-telemetry",
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

describe("index arguments", () => {
  it("defaults to stdout and accepts a repository and output", () => {
    expect(parseArguments(["index"])).toEqual({ command: "index", target: undefined, output: "" });
    expect(parseArguments(["index", "/repo", "-o", "/tmp/ast.json"])).toEqual({
      command: "index",
      target: "/repo",
      output: "/tmp/ast.json",
    });
  });
  it("rejects missing output paths and unexpected arguments", () => {
    expect(() => parseArguments(["index", "--output", "--bad"])).toThrow("needs a path");
    expect(() => parseArguments(["index", "one", "two"])).toThrow("Unexpected argument");
  });
});
