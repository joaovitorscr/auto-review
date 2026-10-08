import { describe, expect, it } from "vitest";
import { planDetectorScopes } from "./scopes.js";

function plan(text: string, options: Parameters<typeof planDetectorScopes>[2] = {}, anchors?: number[]) {
  return planDetectorScopes([{
    file: "view.tsx", status: "M", patch: "", hunks: [],
    reviewLines: anchors ?? text.split("\n").map((_, index) => index + 1),
  }], new Map([["view.tsx", text]]), options);
}

const component = `function View() {
  const [error, setError] = useState("");
  const handle = useCallback(() => {
    setError("failed");
  }, [setError]);
  const padding = "${"x".repeat(600)}";
  if (connected) return <Notice message={error} onClick={handle} />;
  return null;
}
function Other() {
  const error = "unrelated";
  return <div>{error}</div>;
}`;

describe("offline detector scope inventory", () => {
  it("keeps callback wrappers, sibling state references and guarded consumers without shadowed references", () => {
    const result = plan(component, { primaryCharacters: 400, payloadCharacters: 4000 }, [3, 4, 5]);
    const scope = result.files[0]!.scopes.find((entry) => entry.payload.primary.some((part) => part.text.includes("useCallback")))!;
    expect(scope.payload.primary.map((entry) => entry.text).join("\n")).toContain("}, [setError]);");
    const support = scope.payload.supporting.map((entry) => entry.text).join("\n");
    expect(support).toContain('const [error, setError] = useState("");');
    expect(support).toContain("if (connected) return <Notice message={error} onClick={handle} />;");
    expect(support).not.toContain("unrelated");
    expect(scope.unresolved).toContain("useCallback");
    expect(result.modelReady).toBe(false);
  });

  it("owns each anchor once, marks large unsplit statements, and does not hide excess parts", () => {
    const result = plan(component, { primaryCharacters: 400, payloadCharacters: 1200, maxParts: 1 });
    const file = result.files[0]!;
    const anchors = file.scopes.flatMap((scope) => scope.payload.anchors);
    expect(new Set(anchors).size).toBe(anchors.length);
    expect([...anchors, ...file.unowned].sort((a, b) => a - b)).toEqual(component.split("\n").map((_, i) => i + 1));
    expect(file.scopes.some((scope) => scope.oversized)).toBe(true);
    expect(result.boundedHeadCoverage).toBe(false);
    expect(result.requiredParts).toBe(file.scopes.length);
    expect(result.exceedsPartLimit).toBe(true);
    expect(file.scopes.some((scope) => scope.payload.enclosing.length)).toBe(true);
  });

  it("reports supporting excerpts that cannot fit instead of cutting their guards", () => {
    const result = plan(component, { primaryCharacters: 400, payloadCharacters: 600 }, [4]);
    const scope = result.files[0]!.scopes[0]!;
    expect(scope.omitted.length).toBeGreaterThan(0);
    expect(scope.characters).toBeLessThanOrEqual(600);
    expect(scope.characters).toBe(JSON.stringify(scope.payload).length);
  });

  it("coalesces small declarations rather than making a call per syntax node", () => {
    const result = plan("const a = () => 1;\nconst b = () => a();");
    expect(result.requiredParts).toBe(1);
    expect(result.boundedHeadCoverage).toBe(true);
    expect(result.files[0]!.scopes[0]!.payload.anchors).toEqual([1, 2]);
  });

  it("does not mistake a deleted file for complete head coverage", () => {
    const result = planDetectorScopes([{ file: "gone.ts", status: "D", patch: "", hunks: [], reviewLines: [] }], new Map());
    expect(result.boundedHeadCoverage).toBe(false);
    expect(result.files[0]!.unavailable).toBe(true);
  });

  it("owns comments explicitly and reports invalid anchors and syntax errors", () => {
    expect(plan("// removed behavior\n", {}, [1]).files[0]!.unowned).toEqual([]);
    expect(plan("const value = 1;", {}, [99]).files[0]!.unowned).toEqual([99]);
    const result = plan("function broken( {");
    expect(result.files[0]!.diagnostics.length).toBeGreaterThan(0);
    expect(result.boundedHeadCoverage).toBe(false);
  });

  it("retains every unit sharing a changed line while assigning its anchor only once", () => {
    const result = plan("function f() { return 1; return 2; }", { primaryCharacters: 85 }, [1]);
    const scopes = result.files[0]!.scopes;
    const primary = scopes.flatMap((scope) => scope.payload.primary).map((entry) => entry.text).join("");
    expect(primary).toContain("return 1;");
    expect(primary).toContain("return 2;");
    expect(primary).toContain("function f()");
    expect(scopes.flatMap((scope) => scope.payload.anchors)).toEqual([1]);
    expect(scopes.every((scope) => scope.payload.relatedChangedLines.includes(1))).toBe(true);
  });

  it("follows shorthand property values to their lexical binding", () => {
    const result = plan("const value = 1;\nconst obj = { value };", {}, [1]);
    expect(result.files[0]!.scopes[0]!.payload.supporting.map((entry) => entry.text)).toContain("const obj = { value };");
  });

  it("keeps import declarations without collecting unrelated users of that import", () => {
    const text = `import { shared } from "library";
function changed() { return shared(); }
function unrelated() { return shared("unrelated"); }`;
    const scope = plan(text, {}, [2]).files[0]!.scopes[0]!;
    const support = scope.payload.supporting.map((entry) => entry.text).join("\n");
    expect(support).toContain('import { shared } from "library";');
    expect(support).not.toContain("unrelated");
    expect(scope.unresolved).toContain("shared");
  });

  it("replaces contained support when a complete enclosing excerpt fits", () => {
    const text = `const value = 1;
function helper() {
  const copy = value;
  return copy;
}
function changed() { return helper() + value; }`;
    const scope = plan(text, {}, [6]).files[0]!.scopes[0]!;
    const support = scope.payload.supporting;
    expect(support.some((entry) => entry.text.includes("function helper()"))).toBe(true);
    expect(support.some((entry) => entry.text === "const copy = value;")).toBe(false);
    for (const entry of support)
      expect(support.some((other) => other !== entry && other.start <= entry.start && other.end >= entry.end)).toBe(false);
    expect(scope.characters).toBe(JSON.stringify(scope.payload).length);
  });

  it("compacts adjacent primary ranges and emits each enclosing range once", () => {
    const result = plan(component, { primaryCharacters: 600, payloadCharacters: 4000 });
    for (const scope of result.files[0]!.scopes) {
      const parents = scope.payload.enclosing.map((entry) => `${entry.startLine}:${entry.endLine}`);
      expect(new Set(parents).size).toBe(parents.length);
      const spans = scope.payload.primary;
      for (let i = 1; i < spans.length; i++) expect(spans[i]!.start).toBeGreaterThan(spans[i - 1]!.end);
    }
    const head = plan("const a = 1;\nconst b = 2;").files[0]!.scopes[0]!;
    expect(head.payload.primary.map((entry) => entry.text)).toEqual(["const a = 1;\nconst b = 2;"]);
  });

  it("splits an oversized class into bounded member regions without losing changed anchors", () => {
    const text = `class Store {\n${Array.from({ length: 12 }, (_, i) => `  method${i}() { return "${"x".repeat(150)}"; }`).join("\n")}\n}`;
    const result = plan(text, { primaryCharacters: 1500 });
    expect(result.boundedHeadCoverage).toBe(true);
    const scopes = result.files[0]!.scopes;
    expect(scopes.length).toBeGreaterThan(1);
    expect(scopes.flatMap((scope) => scope.payload.anchors).sort((a, b) => a - b)).toEqual(text.split("\n").map((_, i) => i + 1));
    expect(scopes.flatMap((scope) => scope.payload.primary).map((entry) => entry.text).join("\n")).toContain("method11");
  });

  it("is deterministic and validates budgets", () => {
    expect(plan(component)).toEqual(plan(component));
    expect(() => plan(component, { maxParts: 0 })).toThrow("positive integers");
  });
});
