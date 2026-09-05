import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { walkAst } from "./ast.js";
import { indexRepository } from "./repository-index.js";

describe("walkAst", () => {
  it("visits siblings and can prune a subtree", () => {
    const source = ts.createSourceFile(
      "test.ts",
      "function skip() { hidden(); } visible();",
      ts.ScriptTarget.Latest,
      true,
    );
    const calls: string[] = [];
    walkAst(source, (node) => {
      if (ts.isFunctionDeclaration(node)) return false;
      if (ts.isCallExpression(node)) calls.push(node.expression.getText(source));
    });
    expect(calls).toEqual(["visible"]);
  });
});

describe("indexRepository", () => {
  it("builds located call edges across aliases, scopes, JS and TSX without indexing ignored files", async () => {
    const root = await mkdtemp(join(tmpdir(), "auto-review-ast-"));
    try {
      execFileSync("git", ["init", "--quiet", root]);
      await mkdir(join(root, "src"));
      const fixtures = {
        ".gitignore": "ignored.ts\n",
        "tsconfig.json": JSON.stringify({
          compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] }, jsx: "preserve" },
        }),
        "src/lib.ts":
          "export function work() { return 1; }\nexport const arrow = () => work();\nexport class Service { run() { return work(); } }",
        "src/barrel.ts": 'export { work as renamed } from "./lib";',
        "src/view.tsx":
          'import { renamed as run } from "./barrel";\nimport { arrow, Service } from "@/lib";\nexport function View() {\n function nested() { function run() {} run(); }\n const value = run(); arrow(); new Service().run(); missing();\n return <div />;\n}',
        "src/plain.js": 'import { work } from "./lib"; work();',
        "src/broken.ts": "export function broken( {",
        "ignored.ts": "ignored();",
        "deleted.ts": "deleted();",
      };
      for (const [file, contents] of Object.entries(fixtures))
        await writeFile(join(root, file), contents);
      await symlink("ignored.ts", join(root, "linked.ts"));
      execFileSync("git", ["-C", root, "add", "deleted.ts"]);
      await rm(join(root, "deleted.ts"));
      const result = await indexRepository(join(root, "src"));
      expect(result.files).toEqual([
        "src/barrel.ts",
        "src/broken.ts",
        "src/lib.ts",
        "src/plain.js",
        "src/view.tsx",
      ]);
      const symbol = (name: string, file: string) =>
        result.symbols.find((entry) => entry.name === name && entry.file === file)!;
      const work = symbol("work", "src/lib.ts");
      expect(work).toMatchObject({ startLine: 1, endLine: 1, start: 0 });
      const runs = result.calls.filter((call) => call.expression === "run");
      expect(runs[1]?.caller).toBe(symbol("View", "src/view.tsx").id);
      expect(runs.map((call) => call.target)).toEqual([symbol("run", "src/view.tsx").id, work.id]);
      expect(result.calls.find((call) => call.expression === "arrow")?.target).toBe(
        result.symbols.find((entry) => entry.kind === "ArrowFunction")?.id,
      );
      expect(result.calls.find((call) => call.expression === "new Service().run")?.target).toBe(
        symbol("run", "src/lib.ts").id,
      );
      expect(result.calls.find((call) => call.expression === "missing")?.target).toBeUndefined();
      expect(result.calls.find((call) => call.file === "src/plain.js")?.target).toBe(work.id);
      expect(result.imports).toContainEqual(
        expect.objectContaining({ module: "@/lib", target: "src/lib.ts" }),
      );
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ file: "src/broken.ts", line: 1 }),
      );
      const ids = new Set(result.symbols.map((entry) => entry.id));
      for (const call of result.calls) {
        if (call.target) expect(ids.has(call.target)).toBe(true);
        if (call.caller) expect(ids.has(call.caller)).toBe(true);
      }
      expect(await indexRepository(root)).toEqual(result);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

it("resolves workspace tsconfig packages without installed node_modules", async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-review-workspace-"));
  try {
    execFileSync("git", ["init", "--quiet", root]);
    await mkdir(join(root, "packages/config"), { recursive: true });
    await writeFile(
      join(root, "packages/config/package.json"),
      JSON.stringify({ name: "@workspace/typescript-config" }),
    );
    await writeFile(
      join(root, "packages/config/base.json"),
      JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler" } }),
    );
    await writeFile(
      join(root, "packages/config/app.json"),
      JSON.stringify({ extends: "./base.json" }),
    );
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({ extends: "@workspace/typescript-config/app.json" }),
    );
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(join(root, "helper.ts"), "export function helper() { return 1; }");
    await writeFile(join(root, "app.ts"), 'import { helper } from "./helper"; helper();');
    const index = await indexRepository(root);
    const helper = index.symbols.find((symbol) => symbol.name === "helper");
    expect(helper).toBeDefined();
    expect(index.calls.find((call) => call.expression === "helper")?.target).toBe(helper?.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
